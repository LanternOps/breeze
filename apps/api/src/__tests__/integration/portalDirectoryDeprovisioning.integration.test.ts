/**
 * Portal directory deprovisioning end to end on real Postgres (portal
 * registration W8 #11385, plan Task 9; invariants 4 and 12; Review Focus 1–5).
 *
 * Every pipeline runs as breeze_app under forced RLS, exactly as production
 * calls it:
 *  - Entra: the sync's state row and `m365_users` cache are seeded by SQL the
 *    way a users run leaves them, then `captureEntraDirectoryRun` (the M365
 *    users hook's last step) captures and evaluates. No executor, no Graph.
 *  - Google: `evaluateGoogleOrg` (the `google-org` job) with ONLY the Google
 *    reader injected; every SQL leg is the real one. No googleapis.com.
 *  - Jobs: `processPortalDirectoryJob` (the worker's handler) runs `apply-run`
 *    synchronously. The enqueue itself is stubbed (no BullMQ consumer here) and
 *    recorded, so a test can assert who enqueued what.
 *  - Routes: the MSP Apply and the portal-users status change go through the
 *    real router (authMiddleware opens the request context; the services run
 *    outside it).
 *  - Mail: the email transport is stubbed; everything that decides to send runs.
 *
 * Fixtures are seeded and read back over the superuser connection.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentMail = vi.hoisted(() => [] as Array<{ method: string; args: unknown[] }>);

vi.mock('../../services/portalDirectory/queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/portalDirectory/queue')>()),
  enqueueApplyRun: vi.fn(async () => true),
}));
vi.mock('../../services/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/email')>();
  // The transport: every send is recorded, nothing leaves the process.
  const stub = new Proxy({}, {
    get: (_target, method) => async (...args: unknown[]) => {
      sentMail.push({ method: String(method), args });
    },
  });
  return { ...actual, getEmailService: () => stub };
});

import { getTestDb } from './setup';
import { createOrganization, createPartner, createRole, createUser, setupTestEnvironment } from './db-utils';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  auditLogs,
  clientAiOrgPolicies,
  clientAiTenantMappings,
  googleWorkspaceConnections,
  m365Connections,
  m365SyncState,
  m365Users,
  partnerUsers,
  partners,
  portalAccessPolicies,
  portalAccessRequests,
  portalDirectoryActions,
  portalDirectoryRuns,
  portalUserIdentities,
  portalUsers,
} from '../../db/schema';
import { authMiddleware } from '../../middleware/auth';
import { registerOrgPortalDirectoryRoutes } from '../../routes/orgPortalDirectory';
import { registerOrgPortalUsersRoutes } from '../../routes/orgPortalUsers';
import { resolveAndMintClientSession } from '../../services/clientAiExchange';
import type { ClientAiEntraClaims } from '../../services/clientAiEntraJwt';
import { createAccessToken } from '../../services/jwt';
import { executeOrgMerge } from '../../services/orgMerge';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';
import { __testOnly as policyTestOnly } from '../../services/portalAccessPolicy';
import {
  resolvePortalOidcSignIn,
  type ResolvePortalOidcSignInInput,
} from '../../services/portalOidc/accountResolution';
import { approvePortalAccessRequest, createPortalAccessRequest } from '../../services/portalAccessRequests';
import { PORTAL_GOOGLE_ISSUER, entraIssuer } from '../../services/portalUserIdentities';
import { ORG_CASCADE_DELETE_ORDER, cascadeDeleteOrg } from '../../services/tenantCascade';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';
import { entraChainKey } from '../../services/portalDirectory/chain';
import { captureEntraDirectoryRun, type EntraCaptureContext } from '../../services/portalDirectory/entraCapture';
import { evaluateGoogleOrg, type DirectoryUsersReader } from '../../services/portalDirectory/googleSource';
import { lockPortalDirectorySource, restorePortalIdentity } from '../../services/portalDirectory/identityDisable';
import { enqueueApplyRun } from '../../services/portalDirectory/queue';
import { decideHeldRunApply, recordEvaluatedRun } from '../../services/portalDirectory/runStore';
import { processPortalDirectoryJob } from '../../services/portalDirectory/worker';

const admin = () => getTestDb();
const ENFORCE = 'PORTAL_DIRECTORY_DEPROVISION_ENFORCE';
const HOUR = 3600_000;
const CUSTOMER = 'C0workspace1';
let savedEnforce: string | undefined;
let savedDrain: string | undefined;

beforeEach(() => {
  savedEnforce = process.env[ENFORCE];
  savedDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;
  delete process.env[ENFORCE];
  process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
  policyTestOnly.setCapabilities({ entra: true, google: true, selfRegistration: false });
  vi.mocked(enqueueApplyRun).mockClear();
  sentMail.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  if (savedEnforce === undefined) delete process.env[ENFORCE];
  else process.env[ENFORCE] = savedEnforce;
  if (savedDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
  else process.env.ORG_MERGE_FENCE_DRAIN_MS = savedDrain;
  policyTestOnly.setCapabilities(null);
  vi.restoreAllMocks();
});

const enforce = () => { process.env[ENFORCE] = 'true'; };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Person { portalUserId: string; identityId: string; subject: string }

interface EntraOrg {
  orgId: string;
  partnerId: string;
  /** An MSP user (decided_by / restored_by need a real row). */
  actorUserId: string;
  tid: string;
  connectionId: string;
  people: Person[];
  generation: number;
}

async function newOrg(): Promise<{ orgId: string; partnerId: string; actorUserId: string }> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const actor = await createUser({ partnerId: partner.id, email: `tech-${randomUUID()}@msp.test`, name: 'Tech One' });
  return { orgId: org.id, partnerId: partner.id, actorUserId: actor.id };
}

async function seedEntraAccount(orgId: string, tid: string, oid = randomUUID()): Promise<Person> {
  const [account] = await admin().insert(portalUsers).values({
    orgId, email: `pu-${randomUUID()}@customer.test`, authMethod: 'entra', status: 'active', browserAccess: 'granted', authEpoch: 5,
  }).returning({ id: portalUsers.id });
  const [identity] = await admin().insert(portalUserIdentities).values({
    orgId, portalUserId: account!.id, provider: 'entra', issuer: entraIssuer(tid), subject: oid, entraTenantId: tid, linkedVia: 'jit',
  }).returning({ id: portalUserIdentities.id });
  return { portalUserId: account!.id, identityId: identity!.id, subject: oid };
}

/** An org (new, or `into`) with a proven tenant, a customer-graph-read connection, a users sync state and `people` Entra accounts. */
async function seedEntraOrg(people: number, into?: { orgId: string; partnerId: string; actorUserId: string }): Promise<EntraOrg> {
  const base = into ?? await newOrg();
  const tid = randomUUID();
  await admin().insert(clientAiTenantMappings).values({
    orgId: base.orgId, entraTenantId: tid, provenAt: new Date(), provenVia: 'proof_run' as const,
    provenEvidence: { via: 'proof_run' as const, adminOid: randomUUID(), runId: randomUUID() }, provenByUserId: null,
  });
  await admin().insert(portalAccessPolicies).values({ orgId: base.orgId, entraEnabled: true, passwordMode: 'allowed', ssoNewPersonMode: 'approval' });
  const [conn] = await admin().insert(m365Connections).values({
    orgId: base.orgId, userId: null, tenantId: tid, consentAttemptId: randomUUID(), clientId: randomUUID(), clientSecret: null,
    profile: 'customer-graph-read', authMode: 'application-certificate', credentialDomain: 'customer-graph-read',
    vaultRef: `akv://vault.example/m365-customer-graph-read-${randomUUID()}/v1`, credentialVersion: 'v1',
    permissionManifestVersion: 3, consentGeneration: 1, status: 'active',
  } as never).returning({ id: m365Connections.id });
  await admin().insert(m365SyncState).values({ orgId: base.orgId, connectionId: conn!.id, domain: 'users', intervalSeconds: 21600 });
  const list: Person[] = [];
  for (let i = 0; i < people; i += 1) list.push(await seedEntraAccount(base.orgId, tid));
  return { ...base, tid, connectionId: conn!.id, people: list, generation: 0 };
}

type Listed = { oid: string; enabled: boolean | null };
const everyone = (f: EntraOrg): Listed[] => f.people.map((p) => ({ oid: p.subject, enabled: true }));
const without = (f: EntraOrg, ...gone: Person[]) => everyone(f).filter((l) => !gone.some((g) => g.subject === l.oid));
const disabling = (f: EntraOrg, ...off: Person[]) =>
  everyone(f).map((l) => (off.some((o) => o.subject === l.oid) ? { ...l, enabled: false } : l));

/**
 * What a users run leaves at its completion commit — a fresh cache of `listed`
 * plus `extra` other directory users, a bumped generation and, when complete,
 * `last_complete_snapshot_at = at` — and the hook's capture for it.
 */
async function syncUsers(f: EntraOrg, p: { at: Date; listed: Listed[]; extra?: number; complete?: boolean }): Promise<EntraCaptureContext> {
  const complete = p.complete ?? true;
  f.generation += 1;
  await admin().delete(m365Users).where(eq(m365Users.orgId, f.orgId));
  const rows = [
    ...p.listed.map((u) => ({ graphId: u.oid, accountEnabled: u.enabled })),
    ...Array.from({ length: p.extra ?? 10 }, () => ({ graphId: randomUUID(), accountEnabled: true })),
  ];
  if (rows.length > 0) await admin().insert(m365Users).values(rows.map((r) => ({ orgId: f.orgId, coreHash: 'a'.repeat(64), ...r })));
  await admin().update(m365SyncState).set({
    runGeneration: f.generation,
    lastItemCount: rows.length,
    truncated: !complete,
    ...(complete ? { lastCompleteSnapshotAt: p.at } : {}),
  }).where(and(eq(m365SyncState.orgId, f.orgId), eq(m365SyncState.domain, 'users')));
  return { orgId: f.orgId, tenantId: f.tid, connectionId: f.connectionId, generation: f.generation, now: p.at, persisted: { complete } };
}

async function capture(f: EntraOrg, p: Parameters<typeof syncUsers>[1]) {
  return captureEntraDirectoryRun(await syncUsers(f, p));
}

async function runsOf(orgId: string) {
  return admin().select().from(portalDirectoryRuns).where(eq(portalDirectoryRuns.orgId, orgId)).orderBy(portalDirectoryRuns.createdAt);
}
async function latestRun(orgId: string) {
  return (await runsOf(orgId)).at(-1)!;
}
async function readRun(id: string) {
  const [row] = await admin().select().from(portalDirectoryRuns).where(eq(portalDirectoryRuns.id, id));
  return row!;
}
async function actionsOf(runId: string) {
  return admin().select().from(portalDirectoryActions).where(eq(portalDirectoryActions.runId, runId));
}
async function readIdentity(id: string) {
  const [row] = await admin().select().from(portalUserIdentities).where(eq(portalUserIdentities.id, id));
  return row!;
}
async function readAccount(id: string) {
  const [row] = await admin().select().from(portalUsers).where(eq(portalUsers.id, id));
  return row!;
}
async function auditsOf(orgId: string, action: string) {
  return admin().select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, action)));
}

/** The worker's `apply-run` handler, run synchronously. */
const runApplyJob = (runId: string, orgId: string) =>
  processPortalDirectoryJob({ name: 'apply-run', data: { runId, orgId } });

/** MSP Apply (service level): the decision commits, then the job applies, as the route + worker do. */
async function mspApply(orgId: string, runId: string, actorUserId: string) {
  const digest = (await readRun(runId)).impactDigest!;
  await decideHeldRunApply({ orgId, runId, actorUserId, impactDigest: digest });
  return runApplyJob(runId, orgId);
}

/** Disable `person`'s identity through the whole Entra pipeline (enforce, first-enforcement hold, MSP Apply, job). */
async function deprovisionThroughPipeline(f: EntraOrg, person: Person, at = new Date(Date.now() - HOUR)) {
  enforce();
  const out = await capture(f, { at, listed: disabling(f, person) });
  expect(out).toMatchObject({ recorded: true, outcome: 'evaluated', disposition: 'held' });
  const run = await latestRun(f.orgId);
  expect(await mspApply(f.orgId, run.id, f.actorUserId)).toEqual({ status: 'applied', applied: 1, skipped: 0 });
  expect(await readIdentity(person.identityId)).toMatchObject({ disabledBlockers: ['entra_directory'], disabledReason: 'account_disabled' });
  return run;
}

// Google -------------------------------------------------------------------

interface GoogleOrg {
  orgId: string;
  partnerId: string;
  actorUserId: string;
  connectionId: string;
  people: Person[];
}

async function seedGoogleOrg(subjects: string[], into?: { orgId: string; partnerId: string; actorUserId: string }): Promise<GoogleOrg> {
  const base = into ?? await newOrg();
  const [conn] = await admin().insert(googleWorkspaceConnections).values({
    orgId: base.orgId, customerDomain: 'customer.example', adminEmail: 'admin@customer.example',
    serviceAccountEmail: 'svc@project.iam.example', serviceAccountKey: 'unused-the-reader-is-injected', status: 'active',
  } as never).returning({ id: googleWorkspaceConnections.id });
  const people: Person[] = [];
  for (const subject of subjects) {
    const [account] = await admin().insert(portalUsers).values({
      orgId: base.orgId, email: `pu-${randomUUID()}@customer.test`, authMethod: 'google', status: 'active', browserAccess: 'granted', authEpoch: 5,
    }).returning({ id: portalUsers.id });
    const [identity] = await admin().insert(portalUserIdentities).values({
      orgId: base.orgId, portalUserId: account!.id, provider: 'google', issuer: PORTAL_GOOGLE_ISSUER, subject, entraTenantId: null, linkedVia: 'jit',
    }).returning({ id: portalUserIdentities.id });
    people.push({ portalUserId: account!.id, identityId: identity!.id, subject });
  }
  return { ...base, connectionId: conn!.id, people };
}

/** A read-only Directory reader over one customer: the admin anchor plus `users` and `extra` others, one page. */
function fakeReader(users: Array<{ id: string; suspended?: boolean; archived?: boolean }>, extra = 10): DirectoryUsersReader {
  const adminUser = { id: 'g-admin', customerId: CUSTOMER, suspended: false };
  const others = Array.from({ length: extra }, (_, i) => ({ id: `g-other-${i}`, customerId: CUSTOMER }));
  return {
    getUser: async () => ({ id: adminUser.id, customerId: CUSTOMER, isAdmin: true, suspended: false }),
    listUsersPage: async () => ({ users: [adminUser, ...others, ...users.map((u) => ({ customerId: CUSTOMER, ...u }))] }),
  };
}

/** The `google-org` job with only the Google reader injected; every SQL leg is real. */
const googleRun = (orgId: string, utcDate: string, reader: DirectoryUsersReader) =>
  evaluateGoogleOrg(orgId, utcDate, { decryptKey: () => '{}', makeReader: () => reader });

// Sign-in ------------------------------------------------------------------

const noInvite: ResolvePortalOidcSignInInput['inviteConsumer'] = async () => {
  throw new Error('the invite consumer must not be called on this path');
};

function entraSignInIdentity(tid: string, oid: string) {
  return {
    provider: 'entra' as const, issuer: entraIssuer(tid), subject: oid, entraTenantId: tid,
    upn: `returning-${oid.slice(0, 8)}@customer.test`, emailClaim: null, emailDomainOwnerVerified: false, name: 'Pat Person',
  };
}

const fakeRedis = { setex: async () => 'OK', sadd: async () => 1, expire: async () => 1 } as never;

const exchangeClaims = (tid: string, oid: string) => ({
  tid, oid, upn: null, emailClaim: null, emailDomainOwnerVerified: false, email: null, name: 'Ada Addin',
  aud: 'api://breeze', iss: entraIssuer(tid), exp: 0, iat: 0, scp: null,
}) as unknown as ClientAiEntraClaims;

// Routes -------------------------------------------------------------------

/** A partner tech with an MFA'd token against the real router. */
async function routeFixture() {
  const env = await setupTestEnvironment({ scope: 'partner' });
  const token = await createAccessToken({
    sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: null, partnerId: env.partner.id,
    scope: 'partner', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
  const app = new Hono();
  app.use('*', authMiddleware);
  registerOrgPortalDirectoryRoutes(app);
  registerOrgPortalUsersRoutes(app);
  const send = (method: 'POST' | 'PATCH', path: string, body: unknown) => app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { env, base: { orgId: env.organization.id, partnerId: env.partner.id, actorUserId: env.user.id }, send };
}

// ---------------------------------------------------------------------------

describe('portal directory deprovisioning, end to end (W8 Task 9)', () => {
  it('report mode never disables: the full Entra and Google pipelines record reported actions only', async () => { // inv. 12
    const f = await seedEntraOrg(3);
    const [leaver] = f.people;
    expect(await capture(f, { at: new Date(Date.now() - HOUR), listed: disabling(f, leaver!) }))
      .toMatchObject({ recorded: true, outcome: 'evaluated', disposition: 'reported' });
    const entraRun = await latestRun(f.orgId);
    expect(entraRun).toMatchObject({ mode: 'report', disposition: 'reported', affectedCount: 1 });
    expect((await actionsOf(entraRun.id)).map((a) => a.status)).toEqual(['reported']);
    // The apply-run job refuses in report mode (terminal), even handed the run directly.
    expect(await runApplyJob(entraRun.id, f.orgId)).toEqual({ status: 'enforcement_off' });
    await expect(decideHeldRunApply({ orgId: f.orgId, runId: entraRun.id, actorUserId: f.actorUserId, impactDigest: entraRun.impactDigest! }))
      .rejects.toMatchObject({ code: 'PORTAL_DIRECTORY_ENFORCEMENT_OFF' });

    const g = await seedGoogleOrg(['g-on', 'g-susp', 'g-arch']);
    const reader = fakeReader([{ id: 'g-on' }, { id: 'g-susp', suspended: true }, { id: 'g-arch', archived: true }]);
    expect(await googleRun(g.orgId, '2027-02-01', reader)).toEqual({ outcome: 'evaluated' });
    const googleRunRow = await latestRun(g.orgId);
    expect(googleRunRow).toMatchObject({ source: 'google', mode: 'report', disposition: 'reported', affectedCount: 2 });
    expect((await actionsOf(googleRunRow.id)).map((a) => [a.reason, a.status]).sort())
      .toEqual([['archived', 'reported'], ['suspended', 'reported']]);

    for (const p of [...f.people, ...g.people]) {
      expect(await readIdentity(p.identityId)).toMatchObject({ disabledAt: null, disabledBlockers: [] });
      expect(await readAccount(p.portalUserId)).toMatchObject({ status: 'active', disabledBy: null, authEpoch: 5 });
    }
    expect(await auditsOf(f.orgId, 'portal.directory.identity.disable')).toEqual([]);
    expect(await auditsOf(g.orgId, 'portal.directory.identity.disable')).toEqual([]);
    expect(enqueueApplyRun).not.toHaveBeenCalled();
    expect(sentMail).toEqual([]);
  });

  it('enforce: an Entra user with account_enabled=false is disabled after the first-enforcement hold is applied', async () => {
    enforce();
    const { base, send } = await routeFixture();
    const f = await seedEntraOrg(40, base);
    // An active partner admin: the held-run notice's recipient (OD7).
    const adminRole = await createRole({ scope: 'partner', partnerId: f.partnerId, name: 'Partner Admin' });
    const partnerAdmin = await createUser({ partnerId: f.partnerId, email: `admin-${randomUUID()}@msp.test`, name: 'Admin One' });
    await admin().insert(partnerUsers).values({ partnerId: f.partnerId, userId: partnerAdmin.id, roleId: adminRole!.id, orgAccess: 'all' });
    const leaver = f.people[0]!;
    expect(await capture(f, { at: new Date(Date.now() - HOUR), listed: disabling(f, leaver) }))
      .toMatchObject({ recorded: true, outcome: 'evaluated', disposition: 'held' });
    const run = await latestRun(f.orgId);
    expect(run).toMatchObject({ disposition: 'held', holdReason: 'first_enforcement', affectedCount: 1, usableCount: 40 });
    // Held: one held audit and one partner-admin email, nobody disabled yet.
    expect(await auditsOf(f.orgId, 'portal.directory.run.held')).toHaveLength(1);
    expect(sentMail.map((m) => m.method)).toEqual(['sendPortalDirectoryHeld']);
    const notice = sentMail[0]!.args[0] as Record<string, unknown>;
    expect(notice).toMatchObject({ to: [partnerAdmin.email], source: 'entra', affected: 1 });
    // The notice lists no people (D12).
    expect(JSON.stringify(notice)).not.toContain(leaver.subject);
    expect(await readAccount(leaver.portalUserId)).toMatchObject({ status: 'active', authEpoch: 5 });

    // The MSP Apply through the real route: 202, the decision committed, apply-run enqueued, nothing applied yet.
    const res = await send('POST', `/organizations/${f.orgId}/portal-directory/runs/${run.id}/apply`, { impactDigest: run.impactDigest });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { runId: run.id, status: 'applying', actions: 1 } });
    expect(enqueueApplyRun).toHaveBeenCalledWith(run.id, f.orgId);
    expect(await readRun(run.id)).toMatchObject({ disposition: 'applying', decidedByUserId: f.actorUserId });
    expect(await readAccount(leaver.portalUserId)).toMatchObject({ status: 'active', authEpoch: 5 });
    expect(await auditsOf(f.orgId, 'organization.portal_directory.run.apply')).toEqual([
      expect.objectContaining({ actorType: 'user', actorId: f.actorUserId, resourceId: run.id }),
    ]);

    // The worker's apply-run job applies it and ends the run held_applied.
    expect(await runApplyJob(run.id, f.orgId)).toEqual({ status: 'applied', applied: 1, skipped: 0 });
    expect(await readRun(run.id)).toMatchObject({ disposition: 'held_applied' });
    expect(await actionsOf(run.id)).toEqual([expect.objectContaining({ identityId: leaver.identityId, status: 'applied' })]);
    expect(await readIdentity(leaver.identityId)).toMatchObject({
      disabledBlockers: ['entra_directory'], disabledReason: 'account_disabled',
    });
    expect((await readIdentity(leaver.identityId)).disabledAt).not.toBeNull();
    expect(await readAccount(leaver.portalUserId)).toMatchObject({ status: 'disabled', disabledBy: 'directory', authEpoch: 6 });
    expect(await auditsOf(f.orgId, 'portal.directory.identity.disable')).toEqual([
      expect.objectContaining({ actorType: 'system', resourceId: leaver.portalUserId }),
    ]);
    // A second delivery of the same job is a no-op.
    expect(await runApplyJob(run.id, f.orgId)).toEqual({ status: 'applied', applied: 0, skipped: 0 });
    for (const other of f.people.slice(1)) expect(await readAccount(other.portalUserId)).toMatchObject({ status: 'active', authEpoch: 5 });
  });

  it('enforce: absent in two complete snapshots ≥ 4 h apart after membership → disabled; one snapshot → not', async () => {
    enforce();
    const f = await seedEntraOrg(4);
    const [twice, quick, once, stays] = f.people as [Person, Person, Person, Person];
    const t0 = new Date(Date.now() - 12 * HOUR);
    const t1 = new Date(Date.now() - 9 * HOUR);
    const t2 = new Date(Date.now() - 6 * HOUR);
    const t3 = new Date(Date.now() - 4 * HOUR);

    expect(await capture(f, { at: t0, listed: everyone(f) })).toMatchObject({ outcome: 'evaluated', disposition: 'none' });
    expect(await capture(f, { at: t1, listed: without(f, twice) })).toMatchObject({ outcome: 'evaluated', disposition: 'none' });
    expect(await readIdentity(twice.identityId)).toMatchObject({ directoryAbsentRuns: 1 });
    // Two absences only 3 h apart: not yet (the spacing covers replication delay).
    expect(await capture(f, { at: t2, listed: without(f, twice, quick) })).toMatchObject({ outcome: 'evaluated', disposition: 'none' });
    expect(await readIdentity(twice.identityId)).toMatchObject({ directoryAbsentRuns: 2, disabledAt: null });

    // t3: `twice` is 5 h past its first absence → action; `quick` has two absences
    // 2 h apart → none; `once` has one absence → none.
    expect(await capture(f, { at: t3, listed: without(f, twice, quick, once) })).toMatchObject({ outcome: 'evaluated', disposition: 'held' });
    const run = await latestRun(f.orgId);
    expect((await actionsOf(run.id)).map((a) => [a.identityId, a.reason])).toEqual([[twice.identityId, 'absent']]);
    expect(await readIdentity(quick.identityId)).toMatchObject({ directoryAbsentRuns: 2, disabledAt: null });
    expect(await readIdentity(once.identityId)).toMatchObject({ directoryAbsentRuns: 1, disabledAt: null });

    expect(await mspApply(f.orgId, run.id, f.actorUserId)).toEqual({ status: 'applied', applied: 1, skipped: 0 });
    expect(await readIdentity(twice.identityId)).toMatchObject({ disabledReason: 'absent', disabledBlockers: ['entra_directory'] });
    expect(await readAccount(twice.portalUserId)).toMatchObject({ status: 'disabled', disabledBy: 'directory' });
    for (const p of [quick, once, stays]) {
      expect(await readIdentity(p.identityId)).toMatchObject({ disabledAt: null });
      expect(await readAccount(p.portalUserId)).toMatchObject({ status: 'active', authEpoch: 5 });
    }
  });

  it('half the tenant vanishes in one complete snapshot: nothing applied (suspect_shrink)', async () => { // RF1
    enforce();
    const f = await seedEntraOrg(20);
    const half = f.people.slice(10);
    const t0 = new Date(Date.now() - 12 * HOUR);
    expect(await capture(f, { at: t0, listed: everyone(f), extra: 10 })).toMatchObject({ outcome: 'evaluated' });
    const before = await Promise.all(f.people.map((p) => readIdentity(p.identityId)));

    // 30 directory users → 14: below 80% of the last evaluated snapshot. The
    // capture evaluated it; the run row records the guard.
    expect(await capture(f, { at: new Date(t0.getTime() + 5 * HOUR), listed: without(f, ...half), extra: 4 }))
      .toMatchObject({ recorded: true, outcome: 'evaluated', disposition: 'none' });
    const suspect = await latestRun(f.orgId);
    expect(suspect).toMatchObject({ outcome: 'suspect_shrink', disposition: 'none' });
    expect(await actionsOf(suspect.id)).toEqual([]);
    // No observation moved.
    for (const [i, p] of f.people.entries()) {
      const now = await readIdentity(p.identityId);
      expect(now).toMatchObject({ directoryAbsentRuns: 0, directoryLastRunId: before[i]!.directoryLastRunId });
    }

    // A second snapshot agreeing with the suspect one evaluates — a first absence, still nobody acted on.
    expect(await capture(f, { at: new Date(t0.getTime() + 10 * HOUR), listed: without(f, ...half), extra: 4 }))
      .toMatchObject({ outcome: 'evaluated', disposition: 'none' });
    for (const p of half) expect(await readIdentity(p.identityId)).toMatchObject({ directoryAbsentRuns: 1, disabledAt: null });
    const applied = await admin().select().from(portalDirectoryActions)
      .where(and(eq(portalDirectoryActions.orgId, f.orgId), eq(portalDirectoryActions.status, 'applied')));
    expect(applied).toEqual([]);
    for (const p of f.people) expect(await readAccount(p.portalUserId)).toMatchObject({ status: 'active', authEpoch: 5 });
  });

  it('a newer run\'s partial chunks never reach an evaluation', async () => { // RF1
    enforce();
    const f = await seedEntraOrg(3);
    const first = await syncUsers(f, { at: new Date(Date.now() - 6 * HOUR), listed: everyone(f) });
    expect(await captureEntraDirectoryRun(first)).toMatchObject({ outcome: 'evaluated' });

    // Run 2 claims (generation 2), commits one chunk that marks two people stale, then fails:
    // its completion never stamps a snapshot, so last_complete_snapshot_at still names run 1.
    await admin().update(m365SyncState).set({ runGeneration: 2 }).where(eq(m365SyncState.orgId, f.orgId));
    await admin().update(m365Users).set({ isStale: true, staleSince: new Date() })
      .where(and(eq(m365Users.orgId, f.orgId), inArray(m365Users.graphId, [f.people[0]!.subject, f.people[1]!.subject])));
    // A late or replayed capture of run 1 is fenced; run 2's own capture is incomplete.
    expect(await captureEntraDirectoryRun({ ...first })).toEqual({ recorded: false, reason: 'fenced' });
    expect(await captureEntraDirectoryRun({ ...first, generation: 2, now: new Date(), persisted: { complete: false } }))
      .toEqual({ recorded: true, outcome: 'incomplete', reason: 'sync_incomplete' });

    expect((await runsOf(f.orgId)).map((r) => r.outcome)).toEqual(['evaluated', 'incomplete']);
    const actions = await admin().select().from(portalDirectoryActions).where(eq(portalDirectoryActions.orgId, f.orgId));
    expect(actions).toEqual([]);
    for (const p of f.people) {
      expect(await readIdentity(p.identityId)).toMatchObject({ directoryAbsentRuns: 0, disabledAt: null });
      expect(await readAccount(p.portalUserId)).toMatchObject({ status: 'active', authEpoch: 5 });
    }
  });

  it('a truncated run, a disconnect and a re-consent change nothing', async () => { // RF1
    enforce();
    const f = await seedEntraOrg(2);
    const [leaver] = f.people as [Person, Person];
    expect(await capture(f, { at: new Date(Date.now() - 8 * HOUR), listed: everyone(f) })).toMatchObject({ outcome: 'evaluated' });
    const seen = await readIdentity(leaver.identityId);

    // Truncated: the person reads disabled, but the run is incomplete.
    expect(await capture(f, { at: new Date(Date.now() - 7 * HOUR), listed: disabling(f, leaver), complete: false }))
      .toEqual({ recorded: true, outcome: 'incomplete', reason: 'sync_incomplete' });

    // Disconnect: the cache and the state rows are deleted; a capture still in flight is fenced.
    const inFlight = await syncUsers(f, { at: new Date(Date.now() - 6 * HOUR), listed: disabling(f, leaver) });
    await admin().delete(m365Users).where(eq(m365Users.orgId, f.orgId));
    await admin().delete(m365SyncState).where(eq(m365SyncState.orgId, f.orgId));
    expect(await captureEntraDirectoryRun(inFlight)).toEqual({ recorded: false, reason: 'fenced' });

    // Re-consent of the same connection row: a new chain where the leaver was never seen.
    await admin().update(m365Connections).set({ consentGeneration: 2 }).where(eq(m365Connections.id, f.connectionId));
    await admin().insert(m365SyncState).values({ orgId: f.orgId, connectionId: f.connectionId, domain: 'users', intervalSeconds: 21600 });
    expect(await capture(f, { at: new Date(Date.now() - 5 * HOUR), listed: without(f, leaver) }))
      .toMatchObject({ outcome: 'evaluated', disposition: 'none' });
    expect(await readIdentity(leaver.identityId)).toMatchObject({
      directoryChain: entraChainKey({ tenantId: f.tid, connectionId: f.connectionId, consentGeneration: 2, orgId: f.orgId }),
      directorySeenAt: null, directoryAbsentRuns: 0, disabledAt: null,
    });
    expect(seen.directoryChain).not.toBe((await readIdentity(leaver.identityId)).directoryChain);
    const actions = await admin().select().from(portalDirectoryActions).where(eq(portalDirectoryActions.orgId, f.orgId));
    expect(actions).toEqual([]);
    for (const p of f.people) expect(await readAccount(p.portalUserId)).toMatchObject({ status: 'active', authEpoch: 5 });
  });

  it('a google identity from another workspace is never deprovisioned', async () => { // RF2
    enforce();
    const g = await seedGoogleOrg(['g-member', 'g-elsewhere', 'g-leaver']);
    const [member, elsewhere, leaver] = g.people as [Person, Person, Person];
    // 'g-elsewhere' belongs to another Workspace (its hd verified by DNS): this directory never lists it.
    expect(await googleRun(g.orgId, '2027-02-01', fakeReader([{ id: 'g-member' }, { id: 'g-leaver' }]))).toEqual({ outcome: 'evaluated' });
    for (const day of ['2027-02-02', '2027-02-03']) {
      expect(await googleRun(g.orgId, day, fakeReader([{ id: 'g-member' }]))).toEqual({ outcome: 'evaluated' });
    }
    // Same-day re-run: the snapshot key dedupes it.
    expect(await googleRun(g.orgId, '2027-02-03', fakeReader([{ id: 'g-member' }]))).toEqual({ outcome: 'evaluated' });
    expect(await runsOf(g.orgId)).toHaveLength(3);

    // Never seen in this chain: three absences, no count, no action.
    expect(await readIdentity(elsewhere.identityId)).toMatchObject({ directorySeenAt: null, directoryAbsentRuns: 0, disabledAt: null });
    // The control: a member who left is counted (spacing is a real-time property; no action within it).
    expect(await readIdentity(leaver.identityId)).toMatchObject({ directoryAbsentRuns: 2 });
    expect((await readIdentity(member.identityId)).directorySeenAt).not.toBeNull();
    const actions = await admin().select().from(portalDirectoryActions).where(eq(portalDirectoryActions.orgId, g.orgId));
    expect(actions.filter((a) => a.identityId === elsewhere.identityId)).toEqual([]);
    for (const p of g.people) expect(await readAccount(p.portalUserId)).toMatchObject({ status: 'active' });
  });

  it('an entra identity for another tenant is out of scope', async () => { // RF2
    enforce();
    const f = await seedEntraOrg(1);
    const otherTenant = randomUUID();
    // An add-in identity from another tenant, whose object id the directory happens to list as disabled.
    const foreign = await seedEntraAccount(f.orgId, otherTenant);
    const listed = [...everyone(f), { oid: foreign.subject, enabled: false }];
    expect(await capture(f, { at: new Date(Date.now() - HOUR), listed })).toMatchObject({ outcome: 'evaluated', disposition: 'none' });
    const run = await latestRun(f.orgId);
    expect(run).toMatchObject({ usableCount: 1, affectedCount: 0 });
    expect(await actionsOf(run.id)).toEqual([]);
    expect(await readIdentity(foreign.identityId)).toMatchObject({ directoryChain: null, directoryLastRunId: null, disabledAt: null });
    expect(await readAccount(foreign.portalUserId)).toMatchObject({ status: 'active', authEpoch: 5 });
  });

  it('a run for org A never disables an identity in org B', async () => { // inv. 4
    enforce();
    const a = await seedEntraOrg(2);
    const b = await seedEntraOrg(1);
    const bPerson = b.people[0]!;
    // Org A's directory lists one of its own people AND org B's object id as disabled.
    const listed = [...disabling(a, a.people[0]!), { oid: bPerson.subject, enabled: false }];
    expect(await capture(a, { at: new Date(Date.now() - HOUR), listed })).toMatchObject({ disposition: 'held' });
    const run = await latestRun(a.orgId);
    expect((await actionsOf(run.id)).map((x) => x.identityId)).toEqual([a.people[0]!.identityId]);
    expect(await mspApply(a.orgId, run.id, a.actorUserId)).toEqual({ status: 'applied', applied: 1, skipped: 0 });

    expect(await readIdentity(bPerson.identityId)).toMatchObject({ directoryChain: null, directoryLastRunId: null, disabledAt: null });
    expect(await readAccount(bPerson.portalUserId)).toMatchObject({ status: 'active', authEpoch: 5 });
    // B's run lookup never sees A's run.
    await expect(decideHeldRunApply({ orgId: b.orgId, runId: run.id, actorUserId: b.actorUserId, impactDigest: run.impactDigest! }))
      .rejects.toMatchObject({ code: 'PORTAL_DIRECTORY_RUN_NOT_FOUND' });
  });

  it('a disabled identity cannot sign in, exchange an add-in token, be re-linked or come back as a new person', async () => { // RF5
    const f = await seedEntraOrg(2);
    const [leaver, colleague] = f.people as [Person, Person];
    // The leaver also holds a password, so the account stays active (keeps password access).
    await admin().update(portalUsers).set({ authMethod: 'password', passwordHash: 'argon2-hash' }).where(eq(portalUsers.id, leaver.portalUserId));
    await deprovisionThroughPipeline(f, leaver);
    const account = await readAccount(leaver.portalUserId);
    expect(account).toMatchObject({ status: 'active', authEpoch: 6 });
    // Every new-person path open: instant mode would create an account, if anything got that far.
    await admin().update(portalAccessPolicies).set({ ssoNewPersonMode: 'instant' }).where(eq(portalAccessPolicies.orgId, f.orgId));
    const accountsBefore = (await admin().select({ id: portalUsers.id }).from(portalUsers).where(eq(portalUsers.orgId, f.orgId))).length;
    const identity = entraSignInIdentity(f.tid, leaver.subject);

    const login = await resolvePortalOidcSignIn({ purpose: { kind: 'login' }, hostOrgId: null, inviteConsumer: noInvite, identity });
    expect(login).toEqual({ kind: 'denied', reason: 'identity_disabled', orgId: f.orgId });
    const relink = await resolvePortalOidcSignIn({
      purpose: { kind: 'link', portalUserId: leaver.portalUserId, orgId: f.orgId, authEpoch: account.authEpoch },
      hostOrgId: null, inviteConsumer: noInvite, identity,
    });
    expect(relink).toEqual({ kind: 'denied', reason: 'identity_disabled', orgId: f.orgId });
    const colleagueAccount = await readAccount(colleague.portalUserId);
    const hijack = await resolvePortalOidcSignIn({
      purpose: { kind: 'link', portalUserId: colleague.portalUserId, orgId: f.orgId, authEpoch: colleagueAccount.authEpoch },
      hostOrgId: null, inviteConsumer: noInvite, identity,
    });
    expect(hijack).toEqual({ kind: 'denied', reason: 'identity_disabled', orgId: f.orgId });

    // The add-in exchange: the same 401 as an unknown token, no session.
    await admin().update(partners).set({ aiForOfficeEnabled: true }).where(eq(partners.id, f.partnerId));
    await admin().insert(clientAiOrgPolicies).values({ orgId: f.orgId, enabled: true });
    const exchange = await resolveAndMintClientSession(exchangeClaims(f.tid, leaver.subject), fakeRedis);
    expect(exchange).toMatchObject({ kind: 'denied', status: 401, body: { error: 'invalid_token' } });
    expect(exchange.kind === 'denied' && exchange.audit.details).toMatchObject({ reason: 'identity_disabled' });

    // Nothing was written: no account, no request, the identity unchanged and still reserved.
    expect((await admin().select({ id: portalUsers.id }).from(portalUsers).where(eq(portalUsers.orgId, f.orgId)))).toHaveLength(accountsBefore);
    expect(await admin().select().from(portalAccessRequests).where(eq(portalAccessRequests.orgId, f.orgId))).toEqual([]);
    const identities = await admin().select().from(portalUserIdentities).where(eq(portalUserIdentities.subject, leaver.subject));
    expect(identities).toEqual([expect.objectContaining({ id: leaver.identityId, portalUserId: leaver.portalUserId, disabledBlockers: ['entra_directory'] })]);
    expect(await readIdentity(colleague.identityId)).toMatchObject({ disabledAt: null });
  });

  it('a disabled identity cannot come back through SSO access-request approval or an invite', async () => { // RF5 (review); W10 retired the reconcile job (iii)
    const f = await seedEntraOrg(2);
    const [leaver, colleague] = f.people as [Person, Person];
    await deprovisionThroughPipeline(f, leaver);
    const leaverAccount = await readAccount(leaver.portalUserId);
    const leaverIdentity = await readIdentity(leaver.identityId);
    expect(leaverAccount).toMatchObject({ status: 'disabled', disabledBy: 'directory', authEpoch: 6 });
    const accountsOf = async () => (await admin().select({ id: portalUsers.id }).from(portalUsers).where(eq(portalUsers.orgId, f.orgId))).map((r) => r.id).sort();
    const identitiesOfSubject = () => admin().select().from(portalUserIdentities).where(eq(portalUserIdentities.subject, leaver.subject));

    // (i) An SSO access request carrying the disabled (issuer, subject) under a
    // fresh address: approval finds the identity reserved — no second account.
    const created = await createPortalAccessRequest({
      source: 'entra', orgId: f.orgId, email: `returning-${randomUUID()}@customer.test`, name: 'Pat Person', tid: f.tid, oid: leaver.subject,
    });
    expect(created.kind).toBe('created');
    const requestId = (created as { requestId: string }).requestId;
    const accountsBefore = await accountsOf();
    const decider: DbAccessContext = {
      scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId],
      userId: f.actorUserId, currentPartnerId: f.partnerId,
    };
    await expect(withDbAccessContext(decider, () =>
      approvePortalAccessRequest({ orgId: f.orgId, requestId, deciderUserId: f.actorUserId })))
      .rejects.toMatchObject({ code: 'PORTAL_ACCESS_REQUEST_IDENTITY_LINKED', httpStatus: 409 });
    expect(await accountsOf()).toEqual(accountsBefore);
    const [request] = await admin().select().from(portalAccessRequests).where(eq(portalAccessRequests.id, requestId));
    expect(request).toMatchObject({ status: 'pending' });

    // (ii) The invite-bound flow: an invited password account, the disabled
    // identity presented with its invite — denied, the invite never consumed.
    const [invited] = await admin().insert(portalUsers).values({
      orgId: f.orgId, email: `invitee-${randomUUID()}@customer.test`, authMethod: 'password', status: 'invited', browserAccess: 'granted', authEpoch: 2,
    }).returning({ id: portalUsers.id });
    const inviteConsumer = vi.fn(async () => ({ portalUserId: invited!.id, orgId: f.orgId, authEpoch: 2 }));
    const viaInvite = await resolvePortalOidcSignIn({
      purpose: { kind: 'invite', inviteTokenHash: 'a'.repeat(64) }, hostOrgId: null, inviteConsumer,
      identity: entraSignInIdentity(f.tid, leaver.subject),
    });
    expect(viaInvite).toEqual({ kind: 'denied', reason: 'identity_disabled', orgId: f.orgId });
    expect(inviteConsumer).not.toHaveBeenCalled();
    expect(await readAccount(invited!.id)).toMatchObject({ status: 'invited', authEpoch: 2 });
    expect(await admin().select().from(portalUserIdentities).where(eq(portalUserIdentities.portalUserId, invited!.id))).toEqual([]);

    // Through both: one identity row, still disabled and bound to the leaver; nothing else moved.
    expect(await identitiesOfSubject()).toEqual([leaverIdentity]);
    expect(await readAccount(leaver.portalUserId)).toEqual(leaverAccount);
    expect(await readIdentity(colleague.identityId)).toMatchObject({ disabledAt: null });
  });

  it('enforce: a suspended and an archived Google user are disabled through hold, MSP apply route and apply-run job', async () => { // review
    enforce();
    const { base, send } = await routeFixture();
    const g = await seedGoogleOrg(['g-on1', 'g-on2', 'g-on3', 'g-on4', 'g-susp', 'g-arch'], base);
    const susp = g.people[4]!;
    const arch = g.people[5]!;
    const reader = fakeReader([
      { id: 'g-on1' }, { id: 'g-on2' }, { id: 'g-on3' }, { id: 'g-on4' },
      { id: 'g-susp', suspended: true }, { id: 'g-arch', archived: true },
    ]);
    expect(await googleRun(g.orgId, '2027-02-01', reader)).toEqual({ outcome: 'evaluated' });
    const run = await latestRun(g.orgId);
    expect(run).toMatchObject({
      source: 'google', mode: 'enforce', disposition: 'held', holdReason: 'first_enforcement', affectedCount: 2, usableCount: 6,
    });
    expect((await actionsOf(run.id)).map((a) => [a.identityId, a.reason, a.status]).sort())
      .toEqual([[susp.identityId, 'suspended', 'held'], [arch.identityId, 'archived', 'held']].sort());
    // Held: nobody disabled yet.
    for (const p of g.people) expect(await readAccount(p.portalUserId)).toMatchObject({ status: 'active', authEpoch: 5 });

    // MSP Apply through the real route: 202, decision committed, job enqueued.
    const res = await send('POST', `/organizations/${g.orgId}/portal-directory/runs/${run.id}/apply`, { impactDigest: run.impactDigest });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { runId: run.id, status: 'applying', actions: 2 } });
    expect(enqueueApplyRun).toHaveBeenCalledWith(run.id, g.orgId);
    expect(await readAccount(susp.portalUserId)).toMatchObject({ status: 'active', authEpoch: 5 });

    // The apply-run job applies both.
    expect(await runApplyJob(run.id, g.orgId)).toEqual({ status: 'applied', applied: 2, skipped: 0 });
    expect(await readRun(run.id)).toMatchObject({ disposition: 'held_applied' });
    for (const [person, reason] of [[susp, 'suspended'], [arch, 'archived']] as const) {
      const identity = await readIdentity(person.identityId);
      expect(identity).toMatchObject({ disabledBlockers: ['google_directory'], disabledReason: reason });
      expect(identity.disabledAt).not.toBeNull();
      // Identity-only account: disabled by the directory, epoch bumped (sessions end).
      expect(await readAccount(person.portalUserId)).toMatchObject({ status: 'disabled', disabledBy: 'directory', authEpoch: 6 });
    }
    expect((await actionsOf(run.id)).every((a) => a.status === 'applied')).toBe(true);
    expect(await auditsOf(g.orgId, 'portal.directory.identity.disable')).toHaveLength(2);
    for (const p of g.people.slice(0, 4)) expect(await readAccount(p.portalUserId)).toMatchObject({ status: 'active', authEpoch: 5 });
  });

  it('restore + reactivate lets the person sign in again; the next run reports but does not re-disable', async () => { // RF4
    const f = await seedEntraOrg(40);
    const leaver = f.people[0]!;
    await deprovisionThroughPipeline(f, leaver, new Date(Date.now() - 3 * HOUR));
    expect(await readAccount(leaver.portalUserId)).toMatchObject({ status: 'disabled', disabledBy: 'directory' });

    expect(await restorePortalIdentity({
      orgId: f.orgId, portalUserId: leaver.portalUserId, identityId: leaver.identityId,
      reactivateAccount: true, confirmMspDisabled: false, actorUserId: f.actorUserId,
    })).toEqual({ accountStatus: 'active', blockersCleared: ['entra_directory'] });
    expect(await readIdentity(leaver.identityId)).toMatchObject({ disabledAt: null, disabledBlockers: [], directoryAbsentRuns: 0 });
    expect((await readIdentity(leaver.identityId)).directoryRearmSince).not.toBeNull();
    expect(await readAccount(leaver.portalUserId)).toMatchObject({ status: 'active', disabledBy: null });

    const signIn = await resolvePortalOidcSignIn({
      purpose: { kind: 'login' }, hostOrgId: null, inviteConsumer: noInvite, identity: entraSignInIdentity(f.tid, leaver.subject),
    });
    expect(signIn).toMatchObject({ kind: 'session', portalUserId: leaver.portalUserId, orgId: f.orgId, via: 'identity' });

    // The directory still says disabled: the next run lists the person (rearmed) and proposes nothing.
    expect(await capture(f, { at: new Date(Date.now() - HOUR), listed: disabling(f, leaver) }))
      .toMatchObject({ outcome: 'evaluated', disposition: 'none' });
    const next = await latestRun(f.orgId);
    expect((await actionsOf(next.id)).map((a) => [a.identityId, a.status, a.skipReason]))
      .toEqual([[leaver.identityId, 'skipped', 'rearmed']]);
    expect(await readIdentity(leaver.identityId)).toMatchObject({ disabledAt: null });
    expect(await readAccount(leaver.portalUserId)).toMatchObject({ status: 'active' });
    expect(enqueueApplyRun).not.toHaveBeenCalled();
  });

  it('org merge: the absorbed org\'s held run refuses Apply and its identities restart membership', async () => {
    enforce();
    const loser = await seedEntraOrg(40);
    const survivorOrg = await createOrganization({ partnerId: loser.partnerId });
    const person = loser.people[0]!;
    // Seen in the absorbed org's chain, then absent once; and one held run.
    expect(await capture(loser, { at: new Date(Date.now() - 6 * HOUR), listed: everyone(loser) })).toMatchObject({ outcome: 'evaluated' });
    expect(await capture(loser, { at: new Date(Date.now() - 2 * HOUR), listed: disabling(loser, loser.people[1]!).filter((l) => l.oid !== person.subject) }))
      .toMatchObject({ disposition: 'held' });
    const held = await latestRun(loser.orgId);
    expect(await readIdentity(person.identityId)).toMatchObject({ directoryAbsentRuns: 1 });

    await executeOrgMerge({ loserOrgId: loser.orgId, survivorOrgId: survivorOrg.id, partnerId: loser.partnerId, performedBy: loser.actorUserId });

    // The run moved with the org, but its chain still names the absorbed org: Apply refuses.
    expect(await readRun(held.id)).toMatchObject({ orgId: survivorOrg.id, disposition: 'held' });
    await expect(decideHeldRunApply({ orgId: survivorOrg.id, runId: held.id, actorUserId: loser.actorUserId, impactDigest: held.impactDigest! }))
      .rejects.toMatchObject({ code: 'PORTAL_DIRECTORY_RUN_STALE' });
    expect(await readAccount(loser.people[1]!.portalUserId)).toMatchObject({ orgId: survivorOrg.id, status: 'active' });

    // The next snapshot in the survivor's chain resets the observation: absent there, never seen there.
    const moved = await admin().select().from(portalUserIdentities).where(eq(portalUserIdentities.orgId, survivorOrg.id));
    const survivorChain = entraChainKey({ tenantId: loser.tid, connectionId: loser.connectionId, consentGeneration: 1, orgId: survivorOrg.id });
    await withSystemDbAccessContext(async () => {
      await lockPortalDirectorySource(survivorOrg.id, 'entra');
      return recordEvaluatedRun(db, {
        orgId: survivorOrg.id, source: 'entra', snapshotKey: `${loser.connectionId}:1:merged`, snapshotAt: new Date(Date.now() - HOUR),
        chainKey: survivorChain, directoryUserCount: 50,
        identities: moved.map((r) => ({
          identityId: r.id, portalUserId: r.portalUserId, provider: 'entra' as const, subject: r.subject,
          directoryChain: r.directoryChain, directorySeenAt: r.directorySeenAt, directoryAbsentRuns: r.directoryAbsentRuns,
          directoryAbsentSince: r.directoryAbsentSince, directoryLastRunId: r.directoryLastRunId, directoryRearmSince: r.directoryRearmSince,
        })),
        observe: (subject) => (subject === person.subject ? { present: false } : { present: true, state: 'enabled' }),
      });
    });
    expect(await readIdentity(person.identityId)).toMatchObject({
      directoryChain: survivorChain, directorySeenAt: null, directoryAbsentRuns: 0, directoryAbsentSince: null, disabledAt: null,
    });
  });

  it('deleting a portal user removes its actions; cascade and export registrations hold', async () => {
    const f = await seedEntraOrg(2);
    const [gone, kept] = f.people as [Person, Person];
    expect(await capture(f, { at: new Date(Date.now() - HOUR), listed: disabling(f, gone, kept) })).toMatchObject({ disposition: 'reported' });
    const run = await latestRun(f.orgId);
    expect(await actionsOf(run.id)).toHaveLength(2);

    await admin().delete(portalUsers).where(eq(portalUsers.id, gone.portalUserId));
    expect((await actionsOf(run.id)).map((a) => a.identityId)).toEqual([kept.identityId]);
    expect(await readRun(run.id)).toMatchObject({ id: run.id });

    // Registrations: cascade order (actions, then runs, then identities), merge, export.
    const order = [...ORG_CASCADE_DELETE_ORDER];
    const at = (t: string) => order.indexOf(t);
    expect(at('portal_directory_actions')).toBeGreaterThanOrEqual(0);
    expect(at('portal_directory_actions')).toBeLessThan(at('portal_directory_runs'));
    expect(at('portal_directory_runs')).toBeLessThan(at('portal_user_identities'));
    const merge = getOrgMergePolicies();
    expect(merge.has('portal_directory_actions') && merge.has('portal_directory_runs')).toBe(true);
    for (const table of ['portal_directory_actions', 'portal_directory_runs', 'portal_user_identities', 'portal_users']) {
      const live = await admin().execute(sql`
        SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`);
      const columns = (live as unknown as Array<{ column_name: string }>).map((r) => r.column_name).sort();
      expect(Object.keys(CORE_TENANT_EXPORT_POLICY[table]!.columns).sort(), table).toEqual(columns);
    }

    // The org cascade leaves no run or action behind.
    await cascadeDeleteOrg(f.orgId, f.actorUserId);
    expect(await runsOf(f.orgId)).toEqual([]);
    expect(await admin().select().from(portalDirectoryActions).where(eq(portalDirectoryActions.orgId, f.orgId))).toEqual([]);
  });

  it('MSP disable and reactivate through the portal-users route keep disabled_by consistent with status', async () => { // security-review follow-up
    const { base, send } = await routeFixture();
    const f = await seedEntraOrg(2, base);
    const [person, leaver] = f.people as [Person, Person];
    const path = (p: Person) => `/organizations/${f.orgId}/portal-users/${p.portalUserId}`;

    let res = await send('PATCH', path(person), { status: 'disabled' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: person.portalUserId, status: 'disabled' } });
    expect(await readAccount(person.portalUserId)).toMatchObject({ status: 'disabled', disabledBy: 'msp', authEpoch: 6 });

    res = await send('PATCH', path(person), { status: 'active' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: person.portalUserId, status: 'active' } });
    expect(await readAccount(person.portalUserId)).toMatchObject({ status: 'active', disabledBy: null, authEpoch: 7 });

    // A directory-disabled, identity-managed account with no usable credential:
    // the MSP reactivate is refused (invited would strand it) and nothing changes.
    await deprovisionThroughPipeline(f, leaver);
    expect(await readAccount(leaver.portalUserId)).toMatchObject({ status: 'disabled', disabledBy: 'directory', authEpoch: 6 });
    res = await send('PATCH', path(leaver), { status: 'active' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PORTAL_ACCOUNT_RESTORE_SIGN_IN_FIRST');
    expect(await readAccount(leaver.portalUserId)).toMatchObject({ status: 'disabled', disabledBy: 'directory', authEpoch: 6 });
    // Restore with "also re-enable the account" does both: identity cleared, account active.
    res = await send('POST', `${path(leaver)}/identities/${leaver.identityId}/restore`, { reactivateAccount: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { accountStatus: 'active', blockersCleared: ['entra_directory'] } });
    expect(await readAccount(leaver.portalUserId)).toMatchObject({ status: 'active', disabledBy: null, authEpoch: 7 });
    // The MSP disabling it again overrides the provenance to msp.
    res = await send('PATCH', path(leaver), { status: 'disabled' });
    expect(res.status).toBe(200);
    expect(await readAccount(leaver.portalUserId)).toMatchObject({ status: 'disabled', disabledBy: 'msp' });
  });
});
