/**
 * Entra tenant proof: record, transfer, lookups, the AI for Office repoint and
 * the merge race (portal registration W4 #11381, plan Task 2, D7/D8, OD4).
 *
 * The service runs as breeze_app under forced RLS through the real `db` pool,
 * exactly as production calls it (no DB context held: request callers go
 * through runOutsideDbContext). Fixtures are seeded and read back over the
 * superuser connection. Task 8 appends the proof-run routes below.
 */
import './setup';

// config/env.ts reads this at import time; the AI for Office admin group is
// dark (404) without it.
vi.hoisted(() => {
  process.env.CLIENT_AI_ENTRA_CLIENT_ID = process.env.CLIENT_AI_ENTRA_CLIENT_ID || '11111111-1111-4111-8111-111111111111';
});

const mail = vi.hoisted(() => ({
  sent: [] as Array<{ to: string | string[]; partnerName: string; orgName: string; tenantId: string }>,
  fail: false,
  /** Runs inside the send, before it "delivers": lets a test look at the DB from there. */
  onSend: null as null | (() => Promise<void>),
}));

vi.mock('../../services/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/email')>()),
  getEmailService: () => ({
    sendPortalEntraTenantDisplaced: async (params: { to: string | string[]; partnerName: string; orgName: string; tenantId: string }) => {
      if (mail.onSend) await mail.onSend();
      if (mail.fail) throw new Error('smtp unavailable');
      mail.sent.push(params);
    },
  }),
}));

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb } from './setup';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  setupTestEnvironment,
} from './db-utils';
import {
  auditLogs,
  clientAiTenantMappings,
  m365Connections,
  partnerUsers,
  partners,
  portalUserIdentities,
  portalUsers,
  users,
} from '../../db/schema';
import type { PortalEntraProofEvidence, PortalEntraProofVia } from '../../db/schema/clientAi';
import {
  PortalEntraProofError,
  findOrgByProvenEntraTenant,
  findProvenEntraTenantForOrg,
  getPortalEntraTenantStatus,
  proveEntraTenantFromM365Connection,
  recordEntraTenantProof,
  removePortalEntraTenant,
  type RecordEntraProofInput,
} from '../../services/portalEntraTenantProof';
import { entraIssuer } from '../../services/portalUserIdentities';
import { createAccessToken } from '../../services/jwt';
import { clientAiAdminRoutes } from '../../routes/clientAi/admin';
import * as orgMergeModule from '../../services/orgMerge';
import { authMiddleware } from '../../middleware/auth';
import { registerPortalEntraTenantRoutes } from '../../routes/orgPortalEntraTenant';
import { peekPortalEntraProofRun } from '../../services/portalOidc/proofRunStore';
import { portalRoutes } from '../../routes/portal';
import { portalEntraProofRuns, portalOidcStates, portalRateLimitBuckets } from '../../routes/portal/helpers';
import { __testOnly as oidcTestOnly } from '../../routes/portal/oidc';

const admin = () => getTestDb();
const newTenant = () => randomUUID();

beforeEach(() => {
  mail.sent = [];
  mail.fail = false;
  mail.onSend = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedMapping(
  orgId: string,
  tenantId: string,
  proof?: { via: PortalEntraProofVia; evidence: PortalEntraProofEvidence; at?: Date; byUserId?: string | null },
) {
  const [row] = await admin().insert(clientAiTenantMappings).values({
    orgId,
    entraTenantId: tenantId,
    ...(proof ? {
      provenAt: proof.at ?? new Date('2027-01-01T00:00:00Z'),
      provenVia: proof.via,
      provenEvidence: proof.evidence,
      provenByUserId: proof.byUserId ?? null,
    } : {}),
  }).returning();
  return row!;
}

const provenByConnection = (): { via: 'm365_connection'; evidence: PortalEntraProofEvidence } => ({
  via: 'm365_connection',
  evidence: { via: 'm365_connection', connectionId: randomUUID(), profile: 'customer-graph-read' },
});

async function mappingFor(orgId: string) {
  const [row] = await admin().select().from(clientAiTenantMappings).where(eq(clientAiTenantMappings.orgId, orgId));
  return row ?? null;
}

async function mappingsForTenant(tenantId: string) {
  return admin().select().from(clientAiTenantMappings).where(eq(clientAiTenantMappings.entraTenantId, tenantId));
}

async function seedAccount(orgId: string, identityTenant: string | null) {
  const [user] = await admin().insert(portalUsers).values({
    orgId,
    email: `pu-${randomUUID()}@customer.test`,
    authMethod: identityTenant ? 'entra' : 'password',
    status: 'active',
    browserAccess: 'granted',
    // Well in the past, so a bump to now() is visibly later.
    updatedAt: new Date('2020-01-01T00:00:00Z'),
  }).returning();
  if (identityTenant) {
    const oid = randomUUID();
    await admin().insert(portalUserIdentities).values({
      orgId,
      portalUserId: user!.id,
      provider: 'entra',
      issuer: entraIssuer(identityTenant),
      subject: oid,
      entraTenantId: identityTenant,
      linkedVia: 'jit',
    });
  }
  return user!;
}

async function account(id: string) {
  const [row] = await admin().select({ authEpoch: portalUsers.authEpoch, updatedAt: portalUsers.updatedAt })
    .from(portalUsers).where(eq(portalUsers.id, id));
  return row!;
}

async function audits(orgId: string, action: string) {
  return admin().select({ orgId: auditLogs.orgId, details: auditLogs.details, actorId: auditLogs.actorId, actorType: auditLogs.actorType })
    .from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, action)));
}

async function partnerAdmin(partnerId: string, opts: { status?: 'active' | 'disabled'; roleName?: string } = {}) {
  const role = await createRole({ name: opts.roleName ?? 'Partner Admin', scope: 'partner', partnerId });
  const user = await createUser({ partnerId, email: `admin-${randomUUID()}@msp.test`, status: opts.status ?? 'active' });
  await assignUserToPartner(user.id, partnerId, role.id, 'all');
  return user;
}

async function tenantOrg(name?: string) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id, ...(name ? { name } : {}) });
  const tech = await createUser({ partnerId: partner.id, email: `tech-${randomUUID()}@msp.test` });
  return { partner, org, tech };
}

const proofRun = (orgId: string, tenantId: string, provenByUserId: string | null): RecordEntraProofInput => ({
  orgId,
  tenantId,
  via: 'proof_run',
  evidence: { adminOid: randomUUID(), runId: randomUUID() },
  provenByUserId,
});

const connectionProof = (orgId: string, tenantId: string, provenByUserId: string): RecordEntraProofInput => ({
  orgId,
  tenantId,
  via: 'm365_connection',
  evidence: { connectionId: randomUUID(), profile: 'customer-graph-read' },
  provenByUserId,
});

async function proofError(work: Promise<unknown>): Promise<PortalEntraProofError> {
  const err = await work.then(() => null, (e: unknown) => e);
  expect(err, 'expected a PortalEntraProofError').toBeInstanceOf(PortalEntraProofError);
  return err as PortalEntraProofError;
}

describe('recordEntraTenantProof', () => {
  it('proof run on an unmapped tenant creates the proven mapping with evidence and audits proven', async () => {
    const { partner, org, tech } = await tenantOrg();
    const tenant = newTenant();
    const now = new Date('2027-02-03T04:05:06.000Z');
    const input = proofRun(org.id, tenant.toUpperCase(), tech.id);

    expect(await recordEntraTenantProof(input, now)).toEqual({ displaced: null });

    const row = await mappingFor(org.id);
    expect(row).toMatchObject({
      entraTenantId: tenant, // stored lowercased, like the AI for Office PUT
      provenAt: now,
      provenVia: 'proof_run',
      provenByUserId: tech.id,
      provenEvidence: { via: 'proof_run', ...(input.evidence as object) },
      createdBy: tech.id,
    });
    const proven = await audits(org.id, 'organization.portal_identity_proof.proven');
    expect(proven).toHaveLength(1);
    expect(proven[0]).toMatchObject({ actorType: 'user', actorId: tech.id, details: { tenantId: tenant, via: 'proof_run' } });

    expect(await findProvenEntraTenantForOrg(org.id)).toEqual({ tenantId: tenant, provenAt: now });
    expect(await findOrgByProvenEntraTenant(tenant.toUpperCase())).toEqual({ orgId: org.id, partnerId: partner.id });
    expect(await getPortalEntraTenantStatus(org.id)).toEqual({
      tenantId: tenant, state: 'proven', provenAt: now.toISOString(), provenVia: 'proof_run', connectionTenantId: null,
    });
  });

  it('a proof run with no Breeze actor (provenByUserId null) audits as system and leaves createdBy empty', async () => {
    const { org } = await tenantOrg();
    const tenant = newTenant();
    await recordEntraTenantProof(proofRun(org.id, tenant, null));
    expect(await mappingFor(org.id)).toMatchObject({ provenVia: 'proof_run', provenByUserId: null, createdBy: null });
    const [row] = await audits(org.id, 'organization.portal_identity_proof.proven');
    expect(row).toMatchObject({ actorType: 'system' });
  });

  it("proof run on the org's own unproven mapping proves it in place", async () => {
    const { org, tech } = await tenantOrg();
    const tenant = newTenant();
    const seeded = await seedMapping(org.id, tenant);

    expect(await recordEntraTenantProof(proofRun(org.id, tenant, tech.id))).toEqual({ displaced: null });

    const row = await mappingFor(org.id);
    expect(row!.id).toBe(seeded.id);
    expect(row).toMatchObject({ entraTenantId: tenant, provenVia: 'proof_run', provenByUserId: tech.id, createdBy: null });
    expect(row!.provenAt).toBeInstanceOf(Date);
    expect(await getPortalEntraTenantStatus(org.id)).toMatchObject({ state: 'proven' });
  });

  it('proof refused when the org maps a different tenant (409 ORG_HAS_OTHER_TENANT), nothing written', async () => {
    const { org, tech } = await tenantOrg();
    const mapped = newTenant();
    const other = newTenant();
    await seedMapping(org.id, mapped);

    const err = await proofError(recordEntraTenantProof(proofRun(org.id, other, tech.id)));
    expect(err).toMatchObject({ code: 'PORTAL_ENTRA_ORG_HAS_OTHER_TENANT', httpStatus: 409 });

    expect(await mappingFor(org.id)).toMatchObject({ entraTenantId: mapped, provenAt: null, provenVia: null });
    expect(await mappingsForTenant(other)).toHaveLength(0);
    expect(await audits(org.id, 'organization.portal_identity_proof.proven')).toHaveLength(0);
    expect(await getPortalEntraTenantStatus(org.id)).toMatchObject({ tenantId: mapped, state: 'unproven' });
  });

  it("proof run displaces an unproven mapping in another partner's org: row deleted, audits on both orgs", async () => {
    const a = await tenantOrg();
    const b = await tenantOrg();
    const tenant = newTenant();
    await seedMapping(a.org.id, tenant);

    const outcome = await recordEntraTenantProof(proofRun(b.org.id, tenant, b.tech.id));

    expect(outcome).toEqual({ displaced: { orgId: a.org.id, partnerId: a.partner.id, wasProven: false, epochsBumped: 0 } });
    expect(await mappingFor(a.org.id)).toBeNull();
    expect(await mappingFor(b.org.id)).toMatchObject({ entraTenantId: tenant, provenVia: 'proof_run' });
    const displaced = await audits(a.org.id, 'organization.portal_identity_proof.displaced');
    expect(displaced).toHaveLength(1);
    expect(displaced[0]!.details).toEqual({ tenantId: tenant, displacedByOrgId: b.org.id, wasProven: false });
    expect(await audits(b.org.id, 'organization.portal_identity_proof.proven')).toHaveLength(1);
  });

  it("proof run displaces a proven mapping in another partner's org and bumps epochs of that org's tenant identities", async () => {
    const a = await tenantOrg();
    const b = await tenantOrg();
    const tenant = newTenant();
    await seedMapping(a.org.id, tenant, provenByConnection());
    const first = await seedAccount(a.org.id, tenant);
    const second = await seedAccount(a.org.id, tenant);
    const before = await account(first.id);

    const outcome = await recordEntraTenantProof(proofRun(b.org.id, tenant, b.tech.id));

    expect(outcome.displaced).toEqual({ orgId: a.org.id, partnerId: a.partner.id, wasProven: true, epochsBumped: 2 });
    for (const id of [first.id, second.id]) {
      const after = await account(id);
      expect(after.authEpoch).toBe(before.authEpoch + 1);
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    }
    expect(await mappingFor(a.org.id)).toBeNull();
    expect(await findOrgByProvenEntraTenant(tenant)).toEqual({ orgId: b.org.id, partnerId: b.partner.id });
    const [row] = await audits(a.org.id, 'organization.portal_identity_proof.displaced');
    expect(row!.details).toEqual({ tenantId: tenant, displacedByOrgId: b.org.id, wasProven: true });
  });

  it('displacement leaves accounts without an identity in that tenant untouched (epoch unchanged)', async () => {
    const a = await tenantOrg();
    const b = await tenantOrg();
    const c = await tenantOrg();
    const tenant = newTenant();
    await seedMapping(a.org.id, tenant, provenByConnection());
    const inTenant = await seedAccount(a.org.id, tenant);
    const passwordOnly = await seedAccount(a.org.id, null);
    const otherTenant = await seedAccount(a.org.id, newTenant());
    // Same tenant, but in an org that is not being displaced.
    const elsewhere = await seedAccount(c.org.id, tenant);
    const untouched = [passwordOnly, otherTenant, elsewhere];
    const before = await Promise.all(untouched.map((u) => account(u.id)));

    const outcome = await recordEntraTenantProof(proofRun(b.org.id, tenant, b.tech.id));

    expect(outcome.displaced?.epochsBumped).toBe(1);
    expect((await account(inTenant.id)).authEpoch).toBe(2);
    expect(await Promise.all(untouched.map((u) => account(u.id)))).toEqual(before);
  });

  it('m365_connection proof cannot displace a proven mapping (409 TENANT_PROVEN_ELSEWHERE)', async () => {
    const a = await tenantOrg();
    const b = await tenantOrg();
    const tenant = newTenant();
    await seedMapping(a.org.id, tenant, {
      via: 'proof_run', evidence: { via: 'proof_run', adminOid: randomUUID(), runId: randomUUID() },
    });
    const victim = await seedAccount(a.org.id, tenant);

    const err = await proofError(recordEntraTenantProof(connectionProof(b.org.id, tenant, b.tech.id)));
    expect(err).toMatchObject({ code: 'PORTAL_ENTRA_TENANT_PROVEN_ELSEWHERE', httpStatus: 409 });

    expect(await mappingFor(a.org.id)).toMatchObject({ entraTenantId: tenant, provenVia: 'proof_run' });
    expect(await mappingFor(b.org.id)).toBeNull();
    expect((await account(victim.id)).authEpoch).toBe(1);
    expect(await audits(a.org.id, 'organization.portal_identity_proof.displaced')).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  it('m365_connection proof displaces an unproven mapping', async () => {
    const a = await tenantOrg();
    const b = await tenantOrg();
    const tenant = newTenant();
    await seedMapping(a.org.id, tenant);

    const outcome = await recordEntraTenantProof(connectionProof(b.org.id, tenant, b.tech.id));

    expect(outcome.displaced).toMatchObject({ orgId: a.org.id, wasProven: false });
    expect(await mappingFor(b.org.id)).toMatchObject({ provenVia: 'm365_connection' });
  });

  it("m365_connection proof uses the identity-bound tenant of the org's connection; no row → 422 NO_VERIFIED_CONNECTION", async () => {
    const { org, tech } = await tenantOrg();
    const tenant = newTenant();

    const none = await proofError(proveEntraTenantFromM365Connection(org.id, tech.id));
    expect(none).toMatchObject({ code: 'PORTAL_ENTRA_NO_VERIFIED_CONNECTION', httpStatus: 422 });

    const connection = (values: Partial<typeof m365Connections.$inferInsert>) => ({
      orgId: org.id, userId: null, consentAttemptId: randomUUID(), clientId: randomUUID(), clientSecret: null,
      authMode: 'application-certificate' as const, vaultRef: 'akv://vault.example/test-certificate/version',
      credentialVersion: 'test-version', permissionManifestVersion: 1, status: 'active' as const,
      profile: 'customer-graph-read' as const, credentialDomain: 'customer-graph-read' as const,
      ...values,
    });
    // None of these is identity-first tenant evidence: a connection still
    // waiting for consent has no bound tenant, Exchange PowerShell is not one
    // of the Graph profiles the consent flow verifies, and a legacy-direct
    // connection's tenant was TYPED by the MSP (spec §5.4: never proof).
    await admin().insert(m365Connections).values([
      connection({ profile: 'customer-graph-actions', credentialDomain: 'customer-graph-actions', tenantId: null, status: 'pending-consent' }),
      connection({ profile: 'customer-exchange-powershell', credentialDomain: 'customer-exchange-powershell', tenantId: newTenant() }),
      connection({
        profile: 'legacy-direct', credentialDomain: 'legacy-direct', authMode: 'client-secret-legacy', tenantId: newTenant(),
        clientSecret: 'enc:v1:legacy-secret', vaultRef: null, credentialVersion: null, permissionManifestVersion: 0,
      }),
    ]);
    const stillNone = await proofError(proveEntraTenantFromM365Connection(org.id, tech.id));
    expect(stillNone.code).toBe('PORTAL_ENTRA_NO_VERIFIED_CONNECTION');
    expect(await getPortalEntraTenantStatus(org.id)).toEqual({
      tenantId: null, state: 'none', provenAt: null, provenVia: null, connectionTenantId: null,
    });

    const [bound] = await admin().insert(m365Connections).values(connection({ tenantId: tenant })).returning();
    expect(await getPortalEntraTenantStatus(org.id)).toMatchObject({ state: 'none', connectionTenantId: tenant });

    const outcome = await proveEntraTenantFromM365Connection(org.id, tech.id);

    expect(outcome).toEqual({ displaced: null, tenantId: tenant });
    expect(await mappingFor(org.id)).toMatchObject({
      entraTenantId: tenant,
      provenVia: 'm365_connection',
      provenByUserId: tech.id,
      provenEvidence: { via: 'm365_connection', connectionId: bound!.id, profile: 'customer-graph-read' },
    });
  });

  it('findOrgByProvenEntraTenant ignores unproven mappings', async () => {
    const { partner, org, tech } = await tenantOrg();
    const tenant = newTenant();
    await seedMapping(org.id, tenant);

    expect(await findOrgByProvenEntraTenant(tenant)).toBeNull();
    expect(await findProvenEntraTenantForOrg(org.id)).toBeNull();
    expect(await getPortalEntraTenantStatus(org.id)).toMatchObject({ tenantId: tenant, state: 'unproven', provenAt: null });

    await recordEntraTenantProof(proofRun(org.id, tenant, tech.id));
    expect(await findOrgByProvenEntraTenant(tenant)).toEqual({ orgId: org.id, partnerId: partner.id });
  });

  it('removePortalEntraTenant deletes the mapping and reports the tenant it held', async () => {
    const { org, tech } = await tenantOrg();
    const tenant = newTenant();
    await recordEntraTenantProof(proofRun(org.id, tenant, tech.id));

    expect(await removePortalEntraTenant(org.id)).toEqual({ removed: true, tenantId: tenant });
    expect(await mappingFor(org.id)).toBeNull();
    expect(await findOrgByProvenEntraTenant(tenant)).toBeNull();
    expect(await removePortalEntraTenant(org.id)).toEqual({ removed: false, tenantId: null });
  });

  it("displacement emails the displaced partner's active admins after commit; a send failure keeps the proof", async () => {
    const a = await tenantOrg('Contoso Ltd');
    const b = await tenantOrg();
    const adminOne = await partnerAdmin(a.partner.id);
    const adminTwo = await partnerAdmin(a.partner.id);
    await partnerAdmin(a.partner.id, { status: 'disabled' });
    await partnerAdmin(a.partner.id, { roleName: 'Technician' });
    await partnerAdmin(b.partner.id); // the proving partner is never told
    const tenant = newTenant();
    await seedMapping(a.org.id, tenant);
    // Inside the send, the proof must already be committed: the superuser
    // connection sees only committed rows.
    const seenFromSend: Array<string | null> = [];
    mail.onSend = async () => {
      const [row] = await mappingsForTenant(tenant);
      seenFromSend.push(row?.orgId ?? null);
    };

    await recordEntraTenantProof(proofRun(b.org.id, tenant, b.tech.id));

    expect(seenFromSend).toEqual([b.org.id]);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ partnerName: a.partner.name, orgName: 'Contoso Ltd', tenantId: tenant });
    expect([mail.sent[0]!.to].flat().sort()).toEqual([adminOne.email, adminTwo.email].sort());

    // A failing send never undoes the proof, and never surfaces to the caller.
    const c = await tenantOrg();
    const d = await tenantOrg();
    await partnerAdmin(c.partner.id);
    const tenantTwo = newTenant();
    await seedMapping(c.org.id, tenantTwo);
    mail.onSend = null;
    mail.fail = true;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const outcome = await recordEntraTenantProof(proofRun(d.org.id, tenantTwo, d.tech.id));

    expect(outcome.displaced).toMatchObject({ orgId: c.org.id });
    expect(await mappingFor(d.org.id)).toMatchObject({ entraTenantId: tenantTwo, provenVia: 'proof_run' });
    expect(await mappingFor(c.org.id)).toBeNull();
    expect(errorLog).toHaveBeenCalled();
  });

  it('a holding org is refused (409 PORTAL_ENTRA_PROTECTED_ORG) and nothing is written', async () => {
    const partner = await createPartner();
    const holding = await createOrganization({ partnerId: partner.id, type: 'unassigned_pool' });
    const tenant = newTenant();
    const err = await proofError(recordEntraTenantProof(proofRun(holding.id, tenant, null)));
    expect(err).toMatchObject({ code: 'PORTAL_ENTRA_PROTECTED_ORG', httpStatus: 409 });
    expect(await mappingsForTenant(tenant)).toHaveLength(0);
  });
});

/**
 * Review Focus 3 / D7: the advisory lock is taken before any read, so two
 * proofs of one fresh tenant serialize (FOR UPDATE alone locks nothing when no
 * row exists yet). The test holds that same lock on its own connection, starts
 * both proofs as separate promises on separate pooled connections, waits until
 * BOTH are queued behind it, and only then lets them go.
 */
describe('concurrent proofs of one fresh tenant', () => {
  const lockKey = (tenant: string) => `portal-entra-tenant:${tenant}`;

  async function waitersOn(tenant: string): Promise<number> {
    const rows = await admin().execute(sql`
      SELECT count(*)::int AS n FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
         AND objid::bigint = (hashtext(${lockKey(tenant)})::bigint & 4294967295)`) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  }

  /** Holds every tenant's lock until each has `waiters` proofs queued on it, then releases them together. */
  async function raceBehindLocks(waiters: Map<string, number>, inputs: RecordEntraProofInput[]) {
    let pending = null as Promise<PromiseSettledResult<unknown>[]> | null;
    await admin().transaction(async (tx) => {
      for (const tenant of waiters.keys()) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey(tenant)}))`);
      }
      pending = Promise.allSettled(inputs.map((input) => recordEntraTenantProof(input)));
      const deadline = Date.now() + 15_000;
      for (const [tenant, count] of waiters) {
        while ((await waitersOn(tenant)) < count) {
          if (Date.now() > deadline) throw new Error('the proofs never queued on the tenant advisory lock');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    });
    return pending!;
  }

  const raceBehindLock = (tenant: string, inputs: RecordEntraProofInput[]) =>
    raceBehindLocks(new Map([[tenant, inputs.length]]), inputs);

  it('two orgs proving one fresh tenant concurrently: one proof, the other TENANT_PROVEN_ELSEWHERE', async () => {
    const a = await tenantOrg();
    const b = await tenantOrg();
    const tenant = newTenant();

    const results = await raceBehindLock(tenant, [
      connectionProof(a.org.id, tenant, a.tech.id),
      connectionProof(b.org.id, tenant, b.tech.id),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(PortalEntraProofError);
    expect(rejected[0]!.reason).toMatchObject({ code: 'PORTAL_ENTRA_TENANT_PROVEN_ELSEWHERE', httpStatus: 409 });

    const rows = await mappingsForTenant(tenant);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provenVia).toBe('m365_connection');
    const winner = results[0]!.status === 'fulfilled' ? a.org.id : b.org.id;
    expect(rows[0]!.orgId).toBe(winner);
  });

  it('two concurrent proof runs of one fresh tenant: never a 500, one mapping, the later run displaces the earlier', async () => {
    const a = await tenantOrg();
    const b = await tenantOrg();
    const tenant = newTenant();

    const results = await raceBehindLock(tenant, [
      proofRun(a.org.id, tenant, a.tech.id),
      proofRun(b.org.id, tenant, b.tech.id),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const outcomes = results.map((r) => (r as PromiseFulfilledResult<{ displaced: { orgId: string } | null }>).value);
    // Exactly one of them ran second and displaced the other's fresh proof.
    expect(outcomes.filter((o) => o.displaced === null)).toHaveLength(1);
    const later = outcomes.find((o) => o.displaced !== null)!;
    const rows = await mappingsForTenant(tenant);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orgId).not.toBe(later.displaced!.orgId);
    expect(later.displaced).toMatchObject({ wasProven: true });
  });

  // Different tenants take different advisory locks, so for one UNMAPPED org
  // both proofs can read "no own row" before either writes. The upsert must
  // then refuse, not silently repoint the first proof to the second tenant.
  it('one org proving two fresh tenants concurrently: one proof, the other ORG_HAS_OTHER_TENANT', async () => {
    const { org, tech } = await tenantOrg();
    const first = newTenant();
    const second = newTenant();

    const results = await raceBehindLocks(new Map([[first, 1], [second, 1]]), [
      proofRun(org.id, first, tech.id),
      proofRun(org.id, second, tech.id),
    ]);

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: 'PORTAL_ENTRA_ORG_HAS_OTHER_TENANT', httpStatus: 409 });
    const winner = results[0]!.status === 'fulfilled' ? first : second;
    expect(await mappingFor(org.id)).toMatchObject({ entraTenantId: winner, provenVia: 'proof_run' });
    expect(await audits(org.id, 'organization.portal_identity_proof.proven')).toHaveLength(1);
  });
});

describe('inv. 3 through the real AI for Office route', () => {
  it('the AI for Office PUT upsert to a new tenant leaves the mapping unproven', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    await admin().update(partners).set({ aiForOfficeEnabled: true }).where(eq(partners.id, env.partner.id));
    const token = await createAccessToken({
      sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: null, partnerId: env.partner.id,
      scope: 'partner', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    });
    const app = new Hono();
    app.route('/client-ai/admin', clientAiAdminRoutes);
    const put = (entraTenantId: string) => app.request(`/client-ai/admin/orgs/${env.organization.id}/tenant-mapping`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entraTenantId }),
    });
    const proven = newTenant();
    await recordEntraTenantProof(proofRun(env.organization.id, proven, env.user.id));

    // Re-saving the same tenant is not a repoint: the proof stays.
    expect((await put(proven)).status).toBe(200);
    expect(await findProvenEntraTenantForOrg(env.organization.id)).toMatchObject({ tenantId: proven });

    const typed = newTenant();
    expect((await put(typed)).status).toBe(200);

    expect(await mappingFor(env.organization.id)).toMatchObject({
      entraTenantId: typed, provenAt: null, provenVia: null, provenByUserId: null, provenEvidence: null,
    });
    expect(await findProvenEntraTenantForOrg(env.organization.id)).toBeNull();
    expect(await findOrgByProvenEntraTenant(typed)).toBeNull();
    expect(await findOrgByProvenEntraTenant(proven)).toBeNull();
  });
});

describe('org merge race (D8)', () => {
  let priorDrain: string | undefined;
  beforeEach(() => { priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS; process.env.ORG_MERGE_FENCE_DRAIN_MS = '0'; });
  afterEach(() => { if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS; else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain; });

  it('merge: a proof recorded between preview and execute is refused in Phase B (entra_tenant_conflict)', async () => {
    const partner = await createPartner();
    const loser = await createOrganization({ partnerId: partner.id });
    const survivor = await createOrganization({ partnerId: partner.id });
    const actor = await createUser({ partnerId: partner.id, email: `merge-${randomUUID()}@msp.test` });
    const loserTenant = newTenant();
    const survivorTenant = newTenant();
    await seedMapping(loser.id, loserTenant);
    await seedMapping(survivor.id, survivorTenant);

    const preview = await orgMergeModule.previewOrgMerge(loser.id, survivor.id, partner.id);
    expect(preview.blockerCodes).not.toContain('entra_tenant_conflict');

    // The proof lands after the pre-fence check passed: while the loser is
    // being fenced, before the Phase-B transaction opens.
    const realFence = orgMergeModule.fenceLoser;
    vi.spyOn(orgMergeModule, 'fenceLoser').mockImplementationOnce(async (candidate) => {
      await recordEntraTenantProof(proofRun(loser.id, loserTenant, actor.id));
      return realFence(candidate);
    });
    const assertSafe = vi.spyOn(orgMergeModule, 'assertMergeIsolationSafe');

    const error = await orgMergeModule.executeOrgMerge({
      loserOrgId: loser.id, survivorOrgId: survivor.id, partnerId: partner.id,
      performedBy: actor.id, performedByEmail: actor.email,
    }).then(() => null, (err: unknown) => err);

    expect(error).toBeInstanceOf(orgMergeModule.OrgMergeBlockedError);
    expect(error).toMatchObject({ blockerCodes: ['entra_tenant_conflict'] });
    expect(assertSafe).toHaveBeenCalledWith(loser.id, expect.any(Boolean), survivor.id);
    // Rolled back and unfenced: both mappings are where they were, the proof kept.
    expect(await mappingFor(loser.id)).toMatchObject({ entraTenantId: loserTenant, provenVia: 'proof_run' });
    expect(await mappingFor(survivor.id)).toMatchObject({ entraTenantId: survivorTenant, provenAt: null });
    const [org] = await admin().execute(sql`SELECT status FROM organizations WHERE id = ${loser.id}::uuid`) as unknown as Array<{ status: string }>;
    expect(org?.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Task 8: the MSP tenant-proof routes through the real auth middleware, so each
// request holds its own breeze_app transaction and the service runs beside it
// through runOutsideDbContext (it refuses a held context: a missing
// runOutsideDbContext is a 500 here, not a pass).
// ---------------------------------------------------------------------------
describe('MSP tenant-proof routes through the real router (Task 8)', () => {
  const ENV_KEYS = ['PORTAL_ENTRA_CLIENT_ID', 'PORTAL_ENTRA_CLIENT_SECRET', 'PORTAL_ENTRA_CALLBACK_BASE_URL'] as const;
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.PORTAL_ENTRA_CLIENT_ID = '22222222-2222-4222-8222-222222222222';
    process.env.PORTAL_ENTRA_CLIENT_SECRET = 'portal-app-secret';
    process.env.PORTAL_ENTRA_CALLBACK_BASE_URL = 'https://portal.msp.example';
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.unstubAllGlobals();
  });

  async function mspSession() {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const token = await createAccessToken({
      sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: null, partnerId: env.partner.id,
      scope: 'partner', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    });
    const app = new Hono();
    app.use('*', authMiddleware);
    registerPortalEntraTenantRoutes(app);
    const call = (method: string, orgId: string, suffix = '', body?: unknown) =>
      app.request(`/organizations/${orgId}/portal-entra-tenant${suffix}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { env, call };
  }

  /** A tenant binds at most one connection per profile (m365_connections_verified_tenant_profile_uniq). */
  async function seedBoundConnection(
    orgId: string,
    tenantId: string,
    profile: 'customer-graph-read' | 'customer-graph-actions' = 'customer-graph-read',
  ) {
    const [row] = await admin().insert(m365Connections).values({
      orgId, userId: null, consentAttemptId: randomUUID(), clientId: randomUUID(), clientSecret: null,
      authMode: 'application-certificate', vaultRef: 'akv://vault.example/test-certificate/version',
      credentialVersion: 'test-version', permissionManifestVersion: 1, status: 'active',
      profile, credentialDomain: profile, tenantId,
    }).returning();
    return row!;
  }

  it("DELETE removes the mapping (and with it the AI for Office mapping) and audits removed; another partner's org → 404", async () => {
    const { env, call } = await mspSession();
    const tenant = newTenant();
    await recordEntraTenantProof(proofRun(env.organization.id, tenant, env.user.id));

    const res = await call('DELETE', env.organization.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { removed: true, tenantId: tenant } });
    expect(await mappingFor(env.organization.id)).toBeNull();
    expect(await findOrgByProvenEntraTenant(tenant)).toBeNull();
    await vi.waitFor(async () => {
      const rows = await audits(env.organization.id, 'organization.portal_identity_proof.removed');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorType: 'user', actorId: env.user.id, details: { tenantId: tenant } });
    });

    const again = await call('DELETE', env.organization.id);
    expect(await again.json()).toEqual({ data: { removed: false, tenantId: null } });

    const other = await tenantOrg();
    const otherTenant = newTenant();
    await seedMapping(other.org.id, otherTenant);
    const crossPartner = await call('DELETE', other.org.id);
    expect(crossPartner.status).toBe(404);
    expect(await mappingFor(other.org.id)).toMatchObject({ entraTenantId: otherTenant });
  });

  it('prove-from-connection proves via the identity-bound connection and GET shows it with a consent URL; a tenant proven elsewhere → 409, never a 500', async () => {
    const { env, call } = await mspSession();
    const tenant = newTenant();
    const bound = await seedBoundConnection(env.organization.id, tenant);

    const before = await call('GET', env.organization.id);
    expect(before.status).toBe(200);
    expect((await before.json()).data).toEqual({
      tenantId: null, state: 'none', provenAt: null, provenVia: null, connectionTenantId: tenant, consentUrl: null,
    });

    const proved = await call('POST', env.organization.id, '/prove-from-connection');
    expect(proved.status).toBe(200);
    expect((await proved.json()).data).toMatchObject({
      tenantId: tenant, state: 'proven', provenVia: 'm365_connection', connectionTenantId: tenant,
    });
    expect(await mappingFor(env.organization.id)).toMatchObject({
      entraTenantId: tenant,
      provenVia: 'm365_connection',
      provenByUserId: env.user.id,
      provenEvidence: { via: 'm365_connection', connectionId: bound.id, profile: 'customer-graph-read' },
    });

    const status = await call('GET', env.organization.id);
    const { data } = await status.json();
    expect(data).toMatchObject({ tenantId: tenant, state: 'proven' });
    expect(data.consentUrl).toMatch(new RegExp(`^https://login\\.microsoftonline\\.com/${tenant}/v2\\.0/adminconsent\\?`));

    // Another partner's org whose connection is bound to the now-proven tenant:
    // an M365-connection proof cannot displace it (OD4). The refusal is mapped
    // to 409 and the request still commits cleanly.
    const rival = await mspSession();
    await seedBoundConnection(rival.env.organization.id, tenant, 'customer-graph-actions');
    const refused = await rival.call('POST', rival.env.organization.id, '/prove-from-connection');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: expect.any(String), code: 'PORTAL_ENTRA_TENANT_PROVEN_ELSEWHERE' });
    expect(await mappingFor(rival.env.organization.id)).toBeNull();
    expect(await mappingFor(env.organization.id)).toMatchObject({ entraTenantId: tenant, provenVia: 'm365_connection' });

    // No connection at all → 422, also through the request transaction.
    const bare = await mspSession();
    const none = await bare.call('POST', bare.env.organization.id, '/prove-from-connection');
    expect(none.status).toBe(422);
    expect((await none.json()).code).toBe('PORTAL_ENTRA_NO_VERIFIED_CONNECTION');
  });

  it('proof-links with a domain hint pins the tid from the openid-configuration; no hint and no tenant → 422', async () => {
    const { env, call } = await mspSession();
    const tenant = newTenant();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://login.microsoftonline.com/contoso.example/v2.0/.well-known/openid-configuration') {
        return new Response(JSON.stringify({ issuer: `https://login.microsoftonline.com/${tenant}/v2.0` }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'invalid_tenant' }), { status: 400 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await call('POST', env.organization.id, '/proof-links', { tenant: 'Contoso.example' });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.expectedTenantId).toBe(tenant);
    const url = new URL(data.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://portal.msp.example/api/v1/portal/auth/oidc/entra/proof');
    const token = url.searchParams.get('run')!;
    const run = await peekPortalEntraProofRun(token);
    expect(run?.record).toMatchObject({
      orgId: env.organization.id, partnerId: env.partner.id, createdByUserId: env.user.id, expectedTenantId: tenant,
    });
    await vi.waitFor(async () => {
      const rows = await audits(env.organization.id, 'organization.portal_identity_proof.link_created');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorId: env.user.id,
        details: { runId: run!.record.runId, expectedTenantId: tenant, tenantSource: 'hint' },
      });
      expect(JSON.stringify(rows[0])).not.toContain(token);
    });
    // A link is not a proof (inv. 2): nothing was mapped.
    expect(await mappingFor(env.organization.id)).toBeNull();

    const unknown = await call('POST', env.organization.id, '/proof-links', { tenant: 'not-a-tenant.example' });
    expect(unknown.status).toBe(422);
    expect((await unknown.json()).code).toBe('PORTAL_ENTRA_TENANT_HINT_INVALID');

    const required = await call('POST', env.organization.id, '/proof-links', {});
    expect(required.status).toBe(422);
    expect((await required.json()).code).toBe('PORTAL_ENTRA_TENANT_HINT_REQUIRED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Task 8: the proof run end to end. The MSP creates the link through the real
// MSP route (auth middleware + request transaction); the tenant admin opens it
// and returns through the real portal router (public, no DB context held), on
// real Postgres as breeze_app. Microsoft is stubbed at the portal OIDC route's
// NODE_ENV=test seam: the token endpoint and Graph are injected fetches, the
// id_token is signed with a local RS256 key. Nothing reaches the network.
// ---------------------------------------------------------------------------
describe('proof run through the portal router (Task 8, D6)', () => {
  const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
  const PORTAL = 'https://portal.example.test/portal';
  const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';
  const USER_ADMIN = 'fe930be7-5e62-47db-91af-98c3a49a38b1';
  const ENV: Record<string, string> = {
    PORTAL_ENTRA_CLIENT_ID: CLIENT_ID,
    PORTAL_ENTRA_CLIENT_SECRET: 'portal-app-secret',
    PORTAL_ENTRA_CALLBACK_BASE_URL: 'https://portal.msp.example',
    PUBLIC_PORTAL_URL: PORTAL,
  };
  const INVALID = `${PORTAL}/entra-setup?status=invalid`;
  const FAILED = `${PORTAL}/entra-setup?status=failed`;
  let savedEnv: Record<string, string | undefined> = {};
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  const portal = new Hono().route('/api/v1/portal', portalRoutes);

  /** Microsoft's token endpoint, by authorization code: what it answers for each code. */
  const issued = new Map<string, { idToken: string; accessToken: string }>();
  const tokenFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const code = new URLSearchParams(String(init?.body)).get('code') ?? '';
    const tokens = issued.get(code);
    if (!tokens) return new Response('{"error":"invalid_grant"}', { status: 400 });
    return Response.json({ id_token: tokens.idToken, access_token: tokens.accessToken });
  });
  /** Microsoft Graph, by the bearer's principal: who it is, its home tenant, its directory roles. */
  const directory = new Map<string, { oid: string; tid: string; roles: string[] }>();
  let rolesGate: null | (() => Promise<void>) = null;
  const graphFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const bearer = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '').replace(/^Bearer /, '');
    const who = directory.get(bearer);
    if (!who) return new Response('{}', { status: 401 });
    const url = String(input);
    if (url.includes('/v1.0/me?')) return Response.json({ id: who.oid });
    if (url.includes('/v1.0/organization?')) return Response.json({ value: [{ id: who.tid }] });
    if (rolesGate) await rolesGate();
    return Response.json({ value: who.roles.map((roleTemplateId) => ({ roleTemplateId })) });
  });

  beforeAll(async () => {
    keys = await generateKeyPair('RS256', { modulusLength: 2048 });
  });

  beforeEach(() => {
    savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
    Object.assign(process.env, ENV);
    portalOidcStates.clear();
    portalEntraProofRuns.clear();
    portalRateLimitBuckets.clear();
    issued.clear();
    directory.clear();
    rolesGate = null;
    tokenFetch.mockClear();
    graphFetch.mockClear();
    oidcTestOnly.setEntraDeps({
      fetch: tokenFetch as unknown as typeof fetch,
      verificationKey: keys.publicKey,
      graphFetch: graphFetch as unknown as typeof fetch,
    });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    oidcTestOnly.setEntraDeps(null);
  });

  afterAll(() => {
    oidcTestOnly.setEntraDeps(null);
  });

  /** A partner member with full org access (the link's creator) and the org. */
  async function mspWithOrg() {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const token = await createAccessToken({
      sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: null, partnerId: env.partner.id,
      scope: 'partner', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    });
    const msp = new Hono();
    msp.use('*', authMiddleware);
    registerPortalEntraTenantRoutes(msp);
    /** POST proof-links through the real MSP route: the link the MSP sends the tenant admin. */
    const createLink = async (body: { tenant?: string } = {}) => {
      const res = await msp.request(`/organizations/${env.organization.id}/portal-entra-tenant/proof-links`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: { url: string; expectedTenantId: string } };
      const link = new URL(data.url);
      const runToken = link.searchParams.get('run')!;
      const run = (await peekPortalEntraProofRun(runToken))!.record;
      return { path: `${link.pathname}${link.search}`, runToken, run, expectedTenantId: data.expectedTenantId };
    };
    return { env, createLink };
  }

  /** The admin opens the link: 302 to Microsoft, pinned to the run's tenant. */
  async function openLink(path: string) {
    const res = await portal.request(path);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    const binding = res.headers.getSetCookie().find((c) => c.startsWith('breeze_portal_oidc='))!.split(';')[0]!;
    return { location, state: location.searchParams.get('state')!, nonce: location.searchParams.get('nonce')!, binding };
  }

  /** Microsoft signs (tid, oid) in for this flow and hands back a code; Graph knows the principal. */
  async function microsoftSignsIn(
    flow: { nonce: string },
    who: { tid: string; oid: string; roles: string[] },
    extraClaims: Record<string, unknown> = {},
  ): Promise<string> {
    const idToken = await new SignJWT({
      tid: who.tid, oid: who.oid, nonce: flow.nonce, ver: '2.0', iss: entraIssuer(who.tid), aud: CLIENT_ID,
      preferred_username: `admin@${who.tid.slice(0, 8)}.example`, name: 'Tenant Admin', ...extraClaims,
    }).setProtectedHeader({ alg: 'RS256' }).setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
    const code = `code-${randomUUID()}`;
    const accessToken = `graph-access-${randomUUID()}`;
    issued.set(code, { idToken, accessToken });
    directory.set(accessToken, who);
    return code;
  }

  function callback(flow: { state: string; binding: string }, code: string) {
    return portal.request(`/api/v1/portal/auth/oidc/entra/callback?code=${code}&state=${encodeURIComponent(flow.state)}`, {
      headers: { Cookie: flow.binding },
    });
  }

  const adminConsentFor = (tenantId: string) => new RegExp(`^https://login\\.microsoftonline\\.com/${tenantId}/v2\\.0/adminconsent\\?`);

  it('proof run end-to-end with a stubbed token endpoint + Graph role check: mapping proven via proof_run, redirect to adminconsent', async () => {
    const { env, createLink } = await mspWithOrg();
    const tenant = newTenant();
    const link = await createLink({ tenant });
    expect(link.expectedTenantId).toBe(tenant);

    const flow = await openLink(link.path);
    expect(`${flow.location.origin}${flow.location.pathname}`).toBe(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
    expect(flow.location.searchParams.get('scope')).toBe('openid profile Directory.Read.All');

    const adminOid = randomUUID();
    const code = await microsoftSignsIn(flow, { tid: tenant, oid: adminOid, roles: [GLOBAL_ADMIN] });
    const res = await callback(flow, code);
    expect(res.status).toBe(302);
    const consent = new URL(res.headers.get('location')!);
    expect(consent.toString()).toMatch(adminConsentFor(tenant));
    expect(consent.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(consent.searchParams.get('redirect_uri')).toBe('https://portal.msp.example/api/v1/portal/auth/oidc/entra/consent-return');
    expect(res.headers.getSetCookie().find((c) => c.startsWith('breeze_portal_oidc='))).toContain('Max-Age=0');

    // The code went to the pinned tenant's token endpoint; Graph saw the access token it issued.
    expect(String(tokenFetch.mock.calls[0]![0])).toBe(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`);
    expect(graphFetch).toHaveBeenCalledTimes(3);

    expect(await mappingFor(env.organization.id)).toMatchObject({
      entraTenantId: tenant,
      provenVia: 'proof_run',
      provenByUserId: env.user.id,
      provenEvidence: { via: 'proof_run', adminOid, runId: link.run.runId },
    });
    expect(await findOrgByProvenEntraTenant(tenant)).toEqual({ orgId: env.organization.id, partnerId: env.partner.id });
    const proven = await audits(env.organization.id, 'organization.portal_identity_proof.proven');
    expect(proven).toHaveLength(1);
    expect(proven[0]).toMatchObject({ actorType: 'user', actorId: env.user.id, details: { tenantId: tenant, via: 'proof_run' } });
    expect(await audits(env.organization.id, 'organization.portal_identity_proof.failed')).toEqual([]);
    // The link is spent.
    expect(await peekPortalEntraProofRun(link.runToken)).toBeNull();
  });

  it("a B2B guest who is Global Administrator of the pinned tenant completes the proof (Global Constraints: Proof run)", async () => {
    const { env, createLink } = await mspWithOrg();
    const tenant = newTenant();
    const link = await createLink({ tenant });

    // The MSP technician is a guest in the customer's tenant: Microsoft issues
    // the token in that tenant (tid/iss) and marks the guest (idp = home
    // tenant, acct = 1). Graph sees the guest's object in the customer tenant.
    const flow = await openLink(link.path);
    const guestOid = randomUUID();
    const home = newTenant();
    const code = await microsoftSignsIn(
      flow,
      { tid: tenant, oid: guestOid, roles: [GLOBAL_ADMIN] },
      { idp: `https://sts.windows.net/${home}/`, acct: 1 },
    );
    const res = await callback(flow, code);
    expect(res.headers.get('location')).toMatch(adminConsentFor(tenant));
    expect(graphFetch).toHaveBeenCalledTimes(3);

    expect(await mappingFor(env.organization.id)).toMatchObject({
      entraTenantId: tenant,
      provenVia: 'proof_run',
      provenEvidence: { via: 'proof_run', adminOid: guestOid, runId: link.run.runId },
    });
    expect(await mappingsForTenant(home)).toEqual([]);
    expect(await audits(env.organization.id, 'organization.portal_identity_proof.proven')).toHaveLength(1);
    expect(await audits(env.organization.id, 'organization.portal_identity_proof.failed')).toEqual([]);
  });

  it('proof run by a non-admin (Graph check fails) → failed, run still usable', async () => {
    const { env, createLink } = await mspWithOrg();
    const tenant = newTenant();
    const link = await createLink({ tenant });

    const first = await openLink(link.path);
    const userAdmin = await microsoftSignsIn(first, { tid: tenant, oid: randomUUID(), roles: [USER_ADMIN] });
    const refused = await callback(first, userAdmin);
    expect(refused.headers.get('location')).toBe(FAILED);
    expect(await mappingFor(env.organization.id)).toBeNull();
    const failed = await audits(env.organization.id, 'organization.portal_identity_proof.failed');
    expect(failed).toEqual([expect.objectContaining({
      actorType: 'system', details: { reason: 'admin_check_failed', adminCheck: 'no_accepted_role' },
    })]);
    expect(JSON.stringify(failed)).not.toContain(link.runToken);

    // Not burned: the tenant's Global Administrator completes it with the same link.
    expect(await peekPortalEntraProofRun(link.runToken)).not.toBeNull();
    const second = await openLink(link.path);
    const globalAdmin = await microsoftSignsIn(second, { tid: tenant, oid: randomUUID(), roles: [GLOBAL_ADMIN] });
    const done = await callback(second, globalAdmin);
    expect(done.headers.get('location')).toMatch(adminConsentFor(tenant));
    expect(await mappingFor(env.organization.id)).toMatchObject({ entraTenantId: tenant, provenVia: 'proof_run' });
  });

  it("proof run pinned to the org's mapped tenant refuses a token from another tenant", async () => {
    const { env, createLink } = await mspWithOrg();
    const mapped = newTenant();
    await seedMapping(env.organization.id, mapped);
    // No hint: the org's (unproven) mapped tenant is the pin.
    const link = await createLink();
    expect(link.expectedTenantId).toBe(mapped);

    const flow = await openLink(link.path);
    expect(flow.location.pathname).toBe(`/${mapped}/oauth2/v2.0/authorize`);
    const other = newTenant();
    const code = await microsoftSignsIn(flow, { tid: other, oid: randomUUID(), roles: [GLOBAL_ADMIN] });
    const res = await callback(flow, code);
    expect(res.headers.get('location')).toBe(FAILED);

    // Refused at the pinned id_token check: Graph never consulted, nothing recorded, the run untouched.
    expect(graphFetch).not.toHaveBeenCalled();
    expect(await mappingFor(env.organization.id)).toMatchObject({ entraTenantId: mapped, provenAt: null });
    expect(await mappingsForTenant(other)).toEqual([]);
    expect(await peekPortalEntraProofRun(link.runToken)).not.toBeNull();
    expect(await audits(env.organization.id, 'organization.portal_identity_proof.failed')).toEqual([
      expect.objectContaining({ details: { reason: 'token_invalid' } }),
    ]);
  });

  it('a forwarded link opened by the admin of a different tenant → failed (tid ≠ expectedTenantId), nothing recorded', async () => {
    const { env, createLink } = await mspWithOrg();
    const customer = newTenant();
    const link = await createLink({ tenant: customer });

    // The link reached the Global Administrator of some other tenant.
    const stranger = newTenant();
    const flow = await openLink(link.path);
    const code = await microsoftSignsIn(flow, { tid: stranger, oid: randomUUID(), roles: [GLOBAL_ADMIN] });
    const res = await callback(flow, code);
    expect(res.headers.get('location')).toBe(FAILED);

    expect(graphFetch).not.toHaveBeenCalled();
    expect(await mappingFor(env.organization.id)).toBeNull();
    expect(await mappingsForTenant(stranger)).toEqual([]);
    expect(await mappingsForTenant(customer)).toEqual([]);
    expect(await audits(env.organization.id, 'organization.portal_identity_proof.proven')).toEqual([]);
  });

  it('creator deactivated after creating the link → invalid at callback, nothing recorded', async () => {
    for (const revoke of ['deactivated', 'removed from the partner'] as const) {
      const { env, createLink } = await mspWithOrg();
      const tenant = newTenant();
      const link = await createLink({ tenant });
      if (revoke === 'deactivated') {
        await admin().update(users).set({ status: 'disabled' }).where(eq(users.id, env.user.id));
      } else {
        await admin().delete(partnerUsers).where(eq(partnerUsers.userId, env.user.id));
      }

      const flow = await openLink(link.path);
      const code = await microsoftSignsIn(flow, { tid: tenant, oid: randomUUID(), roles: [GLOBAL_ADMIN] });
      const res = await callback(flow, code);
      expect(res.headers.get('location'), revoke).toBe(INVALID);
      expect(await mappingFor(env.organization.id), revoke).toBeNull();
      expect(await mappingsForTenant(tenant), revoke).toEqual([]);
      expect(await audits(env.organization.id, 'organization.portal_identity_proof.failed'), revoke).toEqual([
        expect.objectContaining({ details: { reason: 'creator_unauthorized' } }),
      ]);
      // Consumed by the refused callback: the MSP creates a new link.
      expect(await peekPortalEntraProofRun(link.runToken), revoke).toBeNull();
    }
  });

  it('concurrent proof callbacks record one proof', async () => {
    const { env, createLink } = await mspWithOrg();
    const tenant = newTenant();
    const link = await createLink({ tenant });

    // Two tabs, two states, one run; both pass the admin check before either consumes.
    const tabA = await openLink(link.path);
    const tabB = await openLink(link.path);
    const codeA = await microsoftSignsIn(tabA, { tid: tenant, oid: randomUUID(), roles: [GLOBAL_ADMIN] });
    const codeB = await microsoftSignsIn(tabB, { tid: tenant, oid: randomUUID(), roles: [GLOBAL_ADMIN] });
    let arrived = 0;
    let open!: () => void;
    const bothChecked = new Promise<void>((resolve) => { open = resolve; });
    rolesGate = async () => {
      arrived += 1;
      if (arrived >= 2) open();
      await bothChecked;
    };

    const [a, b] = await Promise.all([callback(tabA, codeA), callback(tabB, codeB)]);
    const locations = [a.headers.get('location')!, b.headers.get('location')!];
    expect(locations.filter((l) => adminConsentFor(tenant).test(l))).toHaveLength(1);
    expect(locations.filter((l) => l === INVALID)).toHaveLength(1);

    expect(await mappingsForTenant(tenant)).toHaveLength(1);
    expect(await audits(env.organization.id, 'organization.portal_identity_proof.proven')).toHaveLength(1);
    expect(await audits(env.organization.id, 'organization.portal_identity_proof.failed')).toEqual([
      expect.objectContaining({ details: { reason: 'run_unavailable' } }),
    ]);
  });

  it('a used run link → invalid', async () => {
    const { env, createLink } = await mspWithOrg();
    const tenant = newTenant();
    const link = await createLink({ tenant });
    const earlierTab = await openLink(link.path);

    const flow = await openLink(link.path);
    const code = await microsoftSignsIn(flow, { tid: tenant, oid: randomUUID(), roles: [GLOBAL_ADMIN] });
    expect((await callback(flow, code)).headers.get('location')).toMatch(adminConsentFor(tenant));

    // Reopening the link: refused before Microsoft, no new flow.
    const reopened = await portal.request(link.path);
    expect(reopened.status).toBe(302);
    expect(reopened.headers.get('location')).toBe(INVALID);
    expect(reopened.headers.getSetCookie().some((c) => c.startsWith('breeze_portal_oidc='))).toBe(false);

    // A tab opened before the proof finishes its sign-in: the run is gone.
    const late = await microsoftSignsIn(earlierTab, { tid: tenant, oid: randomUUID(), roles: [GLOBAL_ADMIN] });
    expect((await callback(earlierTab, late)).headers.get('location')).toBe(INVALID);
    expect(await audits(env.organization.id, 'organization.portal_identity_proof.proven')).toHaveLength(1);
  });
});
