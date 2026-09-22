/**
 * Caller verification (#6354 W01) — live-DB contract suite.
 *
 * Proves against real Postgres what mocks cannot: RLS forgery (42501),
 * composite ownership (23503), XOR ownership (23514), column-specific SET
 * NULL vs. contact cascade, backfill idempotency, the real committed org
 * merge, single-use consume under concurrency, fence-first rejection
 * idempotency, the authenticated route matrix (own site permits / sibling
 * and foreign sites refuse with no side effects), directory sync
 * reconciliation rules, independent login observation, decision/receipt
 * rollback and the device-move revocation hook. Only the external Graph
 * read seam is mocked.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createPartner, createOrganization, createUser, setupTestEnvironment, createSite } from './db-utils';
import { withMoveOrgStepUpGrant } from './moveOrgStepUpFixture';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { contacts } from '../../db/schema/contacts';
import { actionIntents } from '../../db/schema/actionIntents';
import { auditLogs } from '../../db/schema/audit';
import { incidents } from '../../db/schema/incidentResponse';
import { tickets, ticketComments } from '../../db/schema/portal';
import { ticketOutbox } from '../../db/schema/ticketOutbox';
import { organizationUsers, devices, deviceCommands, m365Connections } from '../../db/schema';
import {
  callerVerifications as v, callerVerificationSubjectBindings as b, callerVerificationDestinations as d, callerVerificationPolicies as p,
} from '../../db/schema/callerVerification';
import { executeOrgMerge } from '../../services/orgMerge';
import { createAccessToken } from '../../services/jwt';
import { clearPermissionCache } from '../../services/permissions';
import { callerVerificationRoutes } from '../../routes/callerVerification';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';
import { requireCallerVerification } from '../../services/callerVerification/gate';
import { handleRejection } from '../../services/callerVerification/rejection';
import { createAdministrative, applyDecision } from '../../services/callerVerification/service';
import { observeLogin } from '../../services/callerVerification/subjects';
import { destinationHash } from '../../services/callerVerification/destinations';
import { observeSessionPrincipal } from '../../services/callerVerification/loginObservation';
import { callerVerificationPorts, configureCallerVerificationPorts } from '../../services/callerVerification/ports';
import { CALLER_VERIFICATION_POLICY_DEFAULTS } from '../../services/callerVerification/policy';
import type { CallerVerificationActor } from '../../services/callerVerification/types';

const directoryRead = vi.hoisted(() => vi.fn());
vi.mock('../../services/m365ControlPlane/readActionService', () => ({ executeM365ReadAction: directoryRead }));

let partner: string, A: string, B: string, user: string, ca: string, cb: string, ca2: string, ba: string, bb: string, ba2: string, da: string, dbb: string;
const tenant = '11111111-1111-4111-8111-111111111111';
const oid = '22222222-2222-4222-8222-222222222222';
const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn, 'callerVerification.integration');
const org = (id: string) => ({ scope: 'organization' as const, orgId: id, accessibleOrgIds: [id], accessiblePartnerIds: [], currentPartnerId: partner, userId: user });
function values(orgId = A, contactId = ca) {
  return {
    orgId, contactId, initiatedByUserId: user, technicianLabel: 'Tech', actionScope: 'reset_password' as const,
    method: 'callback_attestation' as const, status: 'verified' as const, tier: 1, tierReason: 'attestation',
    matchValue: '42', decoyValues: ['11', '73'], reverseCode: '1234', attemptNo: 1, expiresAt: new Date(), decidedAt: new Date(),
    targetEntraTenantId: tenant, targetEntraOid: oid,
  };
}
async function grant(patch: Partial<typeof v.$inferInsert> = {}) {
  const [r] = await sys(() => db.insert(v).values({ ...values(), requesterBindingId: ba, targetBindingId: ba, ...patch }).returning());
  return r!;
}
async function code(promise: Promise<unknown>, expected: string) {
  try {
    await promise;
    throw new Error('Expected a SQLSTATE failure');
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    expect(err.code ?? err.cause?.code, String(e)).toBe(expected);
  }
}

beforeEach(async () => {
  process.env.CALLER_VERIFICATION_ENABLED = 'true';
  process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
  partner = (await createPartner())!.id;
  A = (await createOrganization({ partnerId: partner }))!.id;
  B = (await createOrganization({ partnerId: partner }))!.id;
  user = (await createUser({ partnerId: partner, email: `cv-${randomUUID()}@example.com`, status: 'active' }))!.id;
  await sys(async () => {
    const rows = await db.insert(contacts).values([{ orgId: A, name: 'A', roles: ['admin'] }, { orgId: B, name: 'B' }, { orgId: A, name: 'A2' }]).returning();
    [ca, cb, ca2] = rows.map((r) => r.id) as [string, string, string];
    const bindings = await db.insert(b).values([
      { orgId: A, contactId: ca, entraTenantId: tenant, entraOid: oid, source: 'directory_sync', osPrincipal: 'sid:collision' },
      { orgId: B, contactId: cb, entraTenantId: tenant, entraOid: oid, source: 'directory_sync', osPrincipal: 'sid:collision' },
      { orgId: A, contactId: ca2, entraTenantId: tenant, entraOid: randomUUID(), source: 'directory_sync' },
    ]).returning();
    [ba, bb, ba2] = bindings.map((r) => r.id) as [string, string, string];
    const destinations = await db.insert(d).values([
      { orgId: A, contactId: ca, kind: 'email', valueHash: 'a'.repeat(64), valueRedacted: 'a***@example.com', source: 'import' },
      { orgId: B, contactId: cb, kind: 'email', valueHash: 'b'.repeat(64), valueRedacted: 'b***@example.com', source: 'import' },
    ]).returning();
    [da, dbb] = destinations.map((r) => r.id) as [string, string];
    await db.insert(p).values({ partnerId: partner, requiredTierResetPassword: 1, requiredTierDisableUser: 1 });
  });
});
afterEach(() => {
  delete process.env.CALLER_VERIFICATION_ENABLED;
  delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
});

// ---------------------------------------------------------------------------
// Database contracts
// ---------------------------------------------------------------------------

it('all six ownership FKs are deferrable and initially immediate', async () => {
  const rows = await getTestDb().execute(sql`SELECT conname, condeferrable, condeferred FROM pg_constraint WHERE conname IN ('cv_bindings_contact_org_fk','cv_destinations_contact_org_fk','cv_contact_org_fk','cv_requester_fk','cv_target_fk','cv_destination_fk')`);
  expect(rows).toHaveLength(6);
  for (const r of rows as unknown as Array<{ condeferrable: boolean; condeferred: boolean }>) {
    expect(r.condeferrable).toBe(true);
    expect(r.condeferred).toBe(false);
  }
});

it('cross-org insert forgery is 42501 on all four tables; own writes succeed', async () => {
  const attempts = [
    () => db.insert(b).values({ orgId: B, contactId: cb, entraTenantId: tenant, entraOid: randomUUID(), source: 'directory_sync' }),
    () => db.insert(d).values({ orgId: B, contactId: cb, kind: 'mobile', valueHash: 'c'.repeat(64), valueRedacted: '+***12', source: 'import' }),
    () => db.insert(v).values({ ...values(B, cb), requesterBindingId: bb, targetBindingId: bb }),
    () => db.insert(p).values({ orgId: B, requiredTierResetPassword: 3 }),
  ];
  for (const attempt of attempts) await code(withDbAccessContext(org(A), async () => { await attempt(); }), '42501');
  await withDbAccessContext(org(A), async () => {
    await db.insert(p).values({ orgId: A, requireTicket: true });
    expect(await db.select().from(b)).toHaveLength(2);
    expect(await db.select().from(d)).toHaveLength(1);
  });
});

it('system context cannot forge composite ownership, including same-org other contact', async () => {
  for (const patch of [{ requesterBindingId: bb }, { targetBindingId: bb }, { destinationId: dbb }, { requesterBindingId: ba2 }]) await code(grant(patch), '23503');
  const [otherDestination] = await sys(() => db.insert(d).values({ orgId: A, contactId: ca2, kind: 'mobile', valueHash: 'd'.repeat(64), valueRedacted: '+***13', source: 'technician' }).returning());
  await code(grant({ destinationId: otherDestination!.id }), '23503');
  expect((await grant({ destinationId: da })).destinationId).toBe(da);
});

it('replaying the backfill preserves existing epochs and never supplies attestation', async () => {
  const historical = new Date('2026-01-01T00:00:00Z');
  await sys(() => db.update(contacts).set({ email: 'legacy@example.com', mobile: '+15551234567', updatedAt: historical }).where(eq(contacts.id, ca2)));
  const body = readFileSync(new URL('../../../migrations/2026-10-26-170200-caller-verification-destinations-backfill.sql', import.meta.url), 'utf8');
  const block = body.slice(body.indexOf('DO $$'));
  await sys(() => db.execute(sql.raw(block)));
  const first = await sys(() => db.select().from(d).where(eq(d.contactId, ca2)));
  expect(first).toHaveLength(2);
  for (const row of first) expect(row).toMatchObject({ source: 'import', setAt: historical, attestedAt: null });
  await sys(() => db.update(d).set({ attestedAt: new Date(), attestedByUserId: user }).where(eq(d.id, first[0]!.id)));
  const before = await sys(() => db.select().from(d).where(eq(d.contactId, ca2)));
  await sys(() => db.execute(sql.raw(block)));
  expect(await sys(() => db.select().from(d).where(eq(d.contactId, ca2)))).toEqual(before);
});

it('XOR rejects both and neither owner; org token sees but cannot mutate partner baseline', async () => {
  await code(sys(() => db.insert(p).values({ orgId: A, partnerId: partner })), '23514');
  await code(sys(() => db.insert(p).values({})), '23514');
  await withDbAccessContext(org(A), async () => {
    expect((await db.select().from(p).where(eq(p.partnerId, partner))).length).toBe(1);
    expect(await db.update(p).set({ requiredTierResetPassword: 0 }).where(eq(p.partnerId, partner)).returning()).toEqual([]);
    expect(await db.delete(p).where(eq(p.partnerId, partner)).returning()).toEqual([]);
  });
  const other = await createPartner();
  await code(withDbAccessContext(org(A), () => db.insert(p).values({ partnerId: other!.id })), '42501');
});

it('direct child deletion nulls only reference columns; requester hard-delete cascades history', async () => {
  const r = await grant({ destinationId: da });
  await sys(() => db.delete(d).where(eq(d.id, da)));
  await sys(() => db.delete(b).where(eq(b.id, ba)));
  const [kept] = await sys(() => db.select().from(v).where(eq(v.id, r.id)));
  expect(kept).toMatchObject({ orgId: A, contactId: ca, requesterBindingId: null, targetBindingId: null, destinationId: null });
  await sys(() => db.insert(b).values({ orgId: A, contactId: ca, entraTenantId: tenant, entraOid: randomUUID(), source: 'directory_sync' }));
  await sys(() => db.insert(d).values({ orgId: A, contactId: ca, kind: 'mobile', valueHash: 'e'.repeat(64), valueRedacted: '+***11', source: 'technician' }));
  await sys(() => db.delete(contacts).where(eq(contacts.id, ca)));
  expect(await sys(() => db.select().from(v).where(eq(v.id, r.id)))).toEqual([]);
  expect(await sys(() => db.select().from(d).where(eq(d.contactId, ca)))).toEqual([]);
  expect(await sys(() => db.select().from(b).where(eq(b.contactId, ca)))).toEqual([]);
});

it('deleting target contact leaves requester history and refuses target_rebound', async () => {
  const [target] = await sys(() => db.select().from(b).where(eq(b.id, ba2)));
  const r = await grant({ actionScope: 'disable_user', targetBindingId: ba2, targetEntraOid: target!.entraOid });
  await sys(() => db.delete(contacts).where(eq(contacts.id, ca2)));
  const [kept] = await sys(() => db.select().from(v).where(eq(v.id, r.id)));
  expect(kept).toMatchObject({ contactId: ca, orgId: A, targetBindingId: null, targetEntraOid: target!.entraOid });
  await expect(requireCallerVerification({ orgId: A, action: 'disable_user', target: { entraTenantId: tenant, entraOid: target!.entraOid! }, backendTenantId: tenant, technicianUserId: user, intentId: randomUUID(), mode: 'consume' }))
    .rejects.toMatchObject({ payload: { reason: 'target_rebound' } });
});

it('exactly one of two intents consumes; same-intent retry succeeds', async () => {
  const r = await grant();
  const ids = [randomUUID(), randomUUID()];
  const input = { orgId: A, action: 'reset_password' as const, target: { entraTenantId: tenant, entraOid: oid }, backendTenantId: tenant, technicianUserId: user, mode: 'consume' as const };
  const results = await Promise.allSettled(ids.map((intentId) => requireCallerVerification({ ...input, intentId })));
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
  const [stored] = await sys(() => db.select().from(v).where(eq(v.id, r.id)));
  expect(stored!.consumedAt).not.toBeNull();
  expect(await requireCallerVerification({ ...input, intentId: stored!.consumedIntentRef! })).toEqual({ verificationId: r.id, tier: 1 });
});

it('late rejection is idempotent and revokes other unconsumed grants', async () => {
  const [ticket] = await sys(() => db.insert(tickets).values({ orgId: A, partnerId: partner, requesterContactId: ca, ticketNumber: `CV-${randomUUID()}`, subject: 'Caller verification test' }).returning());
  const late = await grant({ status: 'expired', ticketRef: ticket!.id });
  const other = await grant();
  await sys(() => handleRejection(late.id));
  await sys(() => handleRejection(late.id));
  expect(await sys(() => db.select().from(incidents).where(eq(incidents.sourceRef, late.id)))).toHaveLength(1);
  expect(await sys(() => db.select().from(auditLogs).where(and(eq(auditLogs.resourceId, late.id), eq(auditLogs.action, 'caller_verification.rejected'))))).toHaveLength(1);
  const [row] = await sys(() => db.select().from(v).where(eq(v.id, other.id)));
  expect(row!.status).toBe('revoked');
  expect(await sys(() => db.select().from(ticketComments).where(eq(ticketComments.ticketId, ticket!.id)))).toHaveLength(1);
  const outbox = await sys(() => db.select().from(ticketOutbox).where(eq(ticketOutbox.ticketId, ticket!.id)));
  expect(outbox).toHaveLength(1);
  expect(outbox[0]!.payload).toMatchObject({ verificationId: late.id, event: 'rejected' });
});

it('real committed org merge handles pending, consumed and colliding identities', async () => {
  const pending = await grant({ orgId: B, contactId: cb, requesterBindingId: bb, targetBindingId: bb, status: 'pending', decidedAt: null });
  const fresh = await grant({ orgId: B, contactId: cb, requesterBindingId: bb, targetBindingId: bb });
  const intentId = randomUUID();
  await sys(() => db.insert(actionIntents).values({
    id: intentId, orgId: B, partnerId: partner, requestedByUserId: user, source: 'mcp_api', originPrincipalKind: 'user_session', originPrincipalId: user,
    actionName: 'm365_disable_user', argumentDigest: 'a'.repeat(64), targetSummary: 'Disable user', impactSummary: 'Blocks sign-in', riskTier: 3,
    idempotencyKey: randomUUID(), correlationId: randomUUID(), expiresAt: new Date(Date.now() + 60000),
  }));
  const consumed = await grant({ orgId: B, contactId: cb, requesterBindingId: bb, targetBindingId: bb, consumedAt: new Date(), consumedIntentRef: intentId });
  await sys(() => db.insert(p).values([{ orgId: A, requireTicket: true }, { orgId: B, requireTicket: false }]));
  await executeOrgMerge({ loserOrgId: B, survivorOrgId: A, partnerId: partner, performedBy: user });
  const all = await sys(() => db.select().from(v));
  expect(all.find((r) => r.id === pending.id)).toMatchObject({ orgId: A, status: 'expired' });
  expect(all.find((r) => r.id === fresh.id)).toMatchObject({ orgId: A, status: 'revoked' });
  expect(all.find((r) => r.id === consumed.id)).toMatchObject({ orgId: A, consumedIntentRef: intentId });
  expect(all.find((r) => r.id === consumed.id)!.consumedAt).not.toBeNull();
  const mergedBindings = await sys(() => db.select().from(b));
  expect(mergedBindings.filter((r) => [ba, bb].includes(r.id)).every((r) => r.orgId === A && r.revokedAt !== null)).toBe(true);
  expect((await sys(() => db.select().from(p).where(eq(p.orgId, A))))[0]!.requireTicket).toBe(true);
  expect((await sys(() => db.select().from(auditLogs).where(eq(auditLogs.action, 'caller_verification.binding_conflict')))).length).toBeGreaterThanOrEqual(2);
});

// ---------------------------------------------------------------------------
// Authenticated HTTP routes (real JWT, memberships, permissions, RLS)
// ---------------------------------------------------------------------------

const liveApp = new Hono().route('/api/v1', callerVerificationRoutes).route('/api/v1/devices', moveOrgRoutes);
const originalPorts = { ...callerVerificationPorts };
afterEach(() => { configureCallerVerificationPorts(originalPorts); directoryRead.mockReset(); });

function expectHttpVerification(value: Record<string, unknown>) {
  expect(value.remainingAttempts).toEqual(expect.any(Number));
  for (const key of ['usableUntil', 'incidentId', 'consumedAction', 'undeliverableReason']) {
    expect(value).toHaveProperty(key);
    expect(value[key] === null || typeof value[key] === 'string', key).toBe(true);
  }
  expect(value).not.toHaveProperty('challengeTokenHash');
  expect(value).not.toHaveProperty('deliveryPayload');
}

async function liveFixture(scope: 'organization' | 'partner' = 'organization', restricted = true) {
  const env = await setupTestEnvironment({ scope });
  const sibling = await createSite({ orgId: env.organization.id });
  const other = await createOrganization({ partnerId: env.partner.id });
  const otherSite = await createSite({ orgId: other.id });
  if (scope === 'organization' && restricted) {
    await getTestDb().update(organizationUsers).set({ siteIds: [env.site.id] }).where(eq(organizationUsers.userId, env.user.id));
    await clearPermissionCache(env.user.id);
  }
  const token = await createAccessToken({
    sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: scope === 'organization' ? env.organization.id : null,
    partnerId: env.partner.id, scope, mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
  const request = (method: string, path: string, body?: unknown) => liveApp.request(`/api/v1${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const tenants = new Map([[env.organization.id, randomUUID()], [other.id, randomUUID()]]);
  const families = await sys(async () => {
    await db.insert(p).values({ partnerId: env.partner.id, requiredTierResetPassword: 1 });
    for (const [orgId, tenantId] of tenants) {
      await db.insert(m365Connections).values({
        orgId, userId: null, tenantId, consentAttemptId: randomUUID(), clientId: randomUUID(), clientSecret: null, profile: 'customer-graph-read', authMode: 'application-certificate', credentialDomain: 'customer-graph-read',
        vaultRef: 'akv://vault.example/test-certificate/version', credentialVersion: 'test-version', permissionManifestVersion: 1, status: 'active',
      });
    }
    const result = [];
    for (const [orgId, siteId] of [[env.organization.id, env.site.id], [env.organization.id, sibling.id], [other.id, otherSite.id]] as const) {
      const [contact] = await db.insert(contacts).values({ orgId, siteId, name: 'HTTP caller', roles: ['admin'], email: `${randomUUID()}@example.com` }).returning();
      const entraTenantId = tenants.get(orgId)!;
      const entraOid = randomUUID();
      const [binding] = await db.insert(b).values({ orgId, contactId: contact!.id, entraTenantId, entraOid, upnSnapshot: contact!.email, source: 'directory_sync', osPrincipal: `sid:${entraOid}` }).returning();
      const [destination] = await db.insert(d).values({ orgId, contactId: contact!.id, kind: 'email', valueHash: destinationHash(contact!.email!), valueRedacted: 'h***@example.com', source: 'import', setAt: new Date(Date.now() - 10 * 86400000) }).returning();
      const [ticket] = await db.insert(tickets).values({ orgId, partnerId: env.partner.id, requesterContactId: contact!.id, ticketNumber: `HTTP-${randomUUID()}`, subject: 'Caller route fixture' }).returning();
      const [verification] = await db.insert(v).values({
        orgId, contactId: contact!.id, requesterBindingId: binding!.id, targetBindingId: binding!.id, targetEntraTenantId: entraTenantId, targetEntraOid: entraOid,
        initiatedByUserId: env.user.id, technicianLabel: 'HTTP technician', method: 'callback_attestation', actionScope: 'reset_password', status: 'pending', tier: 1, tierReason: 'attestation',
        matchValue: '42', decoyValues: ['11', '73'], reverseCode: '1234', attemptNo: 1, expiresAt: new Date(Date.now() + 600000), ticketRef: ticket!.id, ticketNumber: ticket!.ticketNumber.slice(0, 32),
      }).returning();
      result.push({ orgId, siteId, contact: contact!, binding: binding!, destination: destination!, ticket: ticket!, verification: verification! });
    }
    return result;
  });
  const actor: CallerVerificationActor = {
    userId: env.user.id, partnerId: env.partner.id, scope,
    accessibleOrgIds: scope === 'organization' ? [env.organization.id] : [env.organization.id, other.id],
    allowedSiteIds: scope === 'organization' && restricted ? [env.site.id] : null, displayName: env.user.name,
  };
  return { env, request, actor, families };
}
type LiveFamily = Awaited<ReturnType<typeof liveFixture>>['families'][number];
const contactUrl = (f: LiveFamily) => `/orgs/${f.orgId}/contacts/${f.contact.id}`;
const verificationUrl = (f: LiveFamily) => `/orgs/${f.orgId}/caller-verifications/${f.verification.id}`;
type RouteCase = { name: string; method: string; path: (f: LiveFamily) => string; body?: (f: LiveFamily) => unknown; status: number; projection?: 'row' | 'history' | 'ticket' };
const liveCases: RouteCase[] = [
  { name: 'get', method: 'GET', path: verificationUrl, status: 200, projection: 'row' },
  { name: 'history', method: 'GET', path: (f) => `${contactUrl(f)}/caller-verifications`, status: 200, projection: 'history' },
  { name: 'methods', method: 'GET', path: (f) => `${contactUrl(f)}/caller-verifications/methods`, status: 200 },
  { name: 'start', method: 'POST', path: (f) => `/orgs/${f.orgId}/caller-verifications`, body: (f) => ({ contactId: f.contact.id, method: 'callback_attestation', actionScope: 'reset_password', ticketId: f.ticket.id }), status: 202, projection: 'row' },
  { name: 'cancel', method: 'POST', path: (f) => `${verificationUrl(f)}/cancel`, status: 200, projection: 'row' },
  { name: 'attest', method: 'POST', path: (f) => `${verificationUrl(f)}/attest`, body: () => ({ note: 'Called the established number and confirmed the requester.' }), status: 200, projection: 'row' },
  { name: 'delete binding', method: 'DELETE', path: (f) => `${contactUrl(f)}/caller-verification-bindings/${f.binding.id}`, status: 200 },
  { name: 'attest destination', method: 'POST', path: (f) => `${contactUrl(f)}/caller-verification-destinations/${f.destination.id}/attest`, status: 200 },
  { name: 'override', method: 'POST', path: (f) => `${contactUrl(f)}/caller-verifications/fence-override`, body: () => ({ reason: 'Security confirmed the caller using an independent channel.' }), status: 200 },
  { name: 'ticket', method: 'GET', path: (f) => `/orgs/${f.orgId}/tickets/${f.ticket.id}/caller-verification`, status: 200, projection: 'ticket' },
];

it.each(liveCases)('authenticated $name permits own site and denies sibling/foreign sites', async (entry) => {
  const f = await liveFixture();
  const own = f.families[0]!;
  if (entry.name === 'override') await sys(() => db.update(v).set({ status: 'rejected_by_user', decidedAt: new Date() }).where(eq(v.id, own.verification.id)));
  const response = await f.request(entry.method, entry.path(own), entry.body?.(own));
  expect(response.status, await response.clone().text()).toBe(entry.status);
  const { data } = await response.json();
  if (entry.projection === 'row') expectHttpVerification(data);
  if (entry.projection === 'history') { expect(data.rows).toHaveLength(1); expectHttpVerification(data.rows[0]); }
  if (entry.projection === 'ticket') { expect(data.row.id).toBe(own.verification.id); expectHttpVerification(data.row); }
  if (entry.name === 'start') expect(data.id).not.toBe(own.verification.id);
  if (entry.name === 'cancel') expect(data.status).toBe('cancelled');
  if (entry.name === 'attest') { expect(data.status).toBe('verified'); expect(data.usableUntil).not.toBeNull(); }
  if (entry.name === 'delete binding') expect((await sys(() => db.select().from(b).where(eq(b.id, own.binding.id))))[0]!.revokedAt).not.toBeNull();
  if (entry.name === 'attest destination') expect((await sys(() => db.select().from(d).where(eq(d.id, own.destination.id))))[0]!.attestedByUserId).toBe(f.env.user.id);
  if (entry.name === 'override') expect((await sys(() => db.select().from(v).where(eq(v.id, own.verification.id))))[0]!.fenceOverrideUntil).not.toBeNull();
  for (const denied of f.families.slice(1)) {
    const snapshot = () => sys(async () => ({
      verifications: await db.select().from(v).where(eq(v.contactId, denied.contact.id)).orderBy(v.id),
      bindings: await db.select().from(b).where(eq(b.contactId, denied.contact.id)).orderBy(b.id),
      destinations: await db.select().from(d).where(eq(d.contactId, denied.contact.id)).orderBy(d.id),
    }));
    const before = await snapshot();
    const refusal = await f.request(entry.method, entry.path(denied), entry.body?.(denied));
    expect(refusal.status, await refusal.clone().text()).toBe(404);
    expect(await snapshot()).toEqual(before);
  }
});

it('manual binding uses Graph evidence and denies inaccessible contacts before Graph', async () => {
  // Real Graph read actions reject site-constrained sessions, so the positive is unrestricted.
  const f = await liveFixture('organization', false);
  const own = f.families[0]!;
  directoryRead.mockResolvedValue({ ok: true, kind: 'resource', resource: { id: own.binding.entraOid, userPrincipalName: own.binding.upnSnapshot } });
  const body = (x: LiveFamily) => ({ entraTenantId: x.binding.entraTenantId, entraOid: x.binding.entraOid, upn: x.binding.upnSnapshot });
  const path = (x: LiveFamily) => `${contactUrl(x)}/caller-verification-bindings`;
  const response = await f.request('POST', path(own), body(own));
  expect(response.status, await response.clone().text()).toBe(201);
  expect((await response.json()).data).toMatchObject({ id: own.binding.id, source: 'technician_attested', attestedByUserId: f.env.user.id });
  expect(directoryRead).toHaveBeenCalledTimes(1);
  await getTestDb().update(organizationUsers).set({ siteIds: [f.env.site.id] }).where(eq(organizationUsers.userId, f.env.user.id));
  await clearPermissionCache(f.env.user.id);
  for (const denied of f.families.slice(1)) expect((await f.request('POST', path(denied), body(denied))).status).toBe(404);
  expect(directoryRead).toHaveBeenCalledTimes(1);
});

it.each(['organization', 'partner'] as const)('%s policy GET/PUT return defaults, baseline, own row and effective', async (scope) => {
  const f = await liveFixture(scope, false);
  const orgId = f.env.organization.id;
  await sys(() => db.insert(p).values({ orgId, requiredTierResetPassword: 3 }));
  const path = scope === 'partner' ? '/partner/caller-verification-policy' : `/orgs/${orgId}/caller-verification-policy`;
  const check = async (response: Response, baseline: number, effective: number) => {
    expect(response.status, await response.clone().text()).toBe(200);
    const { data } = await response.json();
    expect(data.defaults).toEqual(CALLER_VERIFICATION_POLICY_DEFAULTS);
    expect(data.baseline.requiredTierResetPassword).toBe(baseline);
    expect(data.effective.requiredTierResetPassword).toBe(effective);
    expect(data.row[scope === 'partner' ? 'partnerId' : 'orgId']).toBe(scope === 'partner' ? f.env.partner.id : orgId);
  };
  await check(await f.request('GET', path), 1, scope === 'partner' ? 1 : 3);
  const next = scope === 'partner' ? 0 : 2;
  await check(await f.request('PUT', path, { requiredTierResetPassword: next }), scope === 'partner' ? 0 : 1, next);
  await check(await f.request('GET', path), scope === 'partner' ? 0 : 1, next);
});

it('admin factory keeps cap before proof consumption, incremented attempt and technician audit', async () => {
  const f = await liveFixture();
  const own = f.families[0]!;
  await sys(() => db.update(p).set({ maxAttemptsPerHour: 2 }).where(eq(p.partnerId, f.env.partner.id)));
  const consume = vi.fn(async () => ({ sid: randomUUID(), authEpoch: 1, mfaEpoch: 1 }));
  configureCallerVerificationPorts({ consumeStepUp: consume });
  const input = { orgId: own.orgId, targetContactId: own.contact.id, reason: 'Confirmed employee offboarding with the authorized HR manager.', stepUpGrantId: randomUUID() };
  const result = await sys(() => createAdministrative(f.actor, input));
  expectHttpVerification(result as unknown as Record<string, unknown>);
  expect((await sys(() => db.select().from(v).where(eq(v.id, result.id))))[0]!.attemptNo).toBe(2);
  const audit = await sys(() => db.select().from(auditLogs).where(and(eq(auditLogs.resourceId, result.id), eq(auditLogs.action, 'caller_verification.administrative_created'))));
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ actorType: 'user', actorId: f.env.user.id });
  await expect(sys(() => createAdministrative(f.actor, { ...input, stepUpGrantId: randomUUID() }))).rejects.toMatchObject({ code: 'attempt_cap' });
  expect(consume).toHaveBeenCalledTimes(1);
});

async function liveDevice(f: LiveFamily) {
  const [row] = await sys(() => db.insert(devices).values({ orgId: f.orgId, siteId: f.siteId, agentId: randomUUID(), hostname: 'Caller workstation', osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: 'test' }).returning());
  return row!;
}

it('real device move revokes old workstation authorization but preserves consumed history', async () => {
  const f = await liveFixture('partner', false);
  const own = f.families[0]!;
  const foreign = f.families[2]!;
  const device = await liveDevice(own);
  await sys(() => db.update(v).set({ method: 'workstation', status: 'verified', tier: 3, tierReason: 'bound_principal', decidedAt: new Date(), workstationDeviceRef: device.id, osPrincipalObserved: own.binding.osPrincipal }).where(eq(v.id, own.verification.id)));
  const consumedIntent = randomUUID();
  const consumedAt = new Date();
  const [consumed] = await sys(() => db.insert(v).values({ ...own.verification, id: randomUUID(), method: 'workstation', status: 'verified', workstationDeviceRef: device.id, decidedAt: new Date(), consumedAt, consumedIntentRef: consumedIntent }).returning());
  const input = { orgId: own.orgId, action: 'reset_password' as const, target: { entraTenantId: own.binding.entraTenantId!, entraOid: own.binding.entraOid! }, backendTenantId: own.binding.entraTenantId!, technicianUserId: f.env.user.id, intentId: randomUUID(), mode: 'check' as const };
  expect(await requireCallerVerification(input)).toMatchObject({ verificationId: own.verification.id });
  expect(await requireCallerVerification({ ...input, intentId: consumedIntent })).toMatchObject({ verificationId: consumed!.id });
  const authHeader = `Bearer ${await createAccessToken({ sub: f.env.user.id, email: f.env.user.email, roleId: f.env.role.id, orgId: null, partnerId: f.env.partner.id, scope: 'partner', mfa: true, aep: 1, mep: 1, sid: randomUUID() })}`;
  const moveBody = await withMoveOrgStepUpGrant(authHeader.slice('Bearer '.length), device.id, { orgId: foreign.orgId, siteId: foreign.siteId });
  const response = await liveApp.request(`/api/v1/devices/${device.id}/move-org`, { method: 'POST', headers: { Authorization: authHeader, 'Content-Type': 'application/json' }, body: JSON.stringify(moveBody) });
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await sys(() => db.select().from(v).where(eq(v.id, own.verification.id))))[0]).toMatchObject({ orgId: own.orgId, workstationDeviceRef: device.id, status: 'revoked', consumedAt: null });
  expect((await sys(() => db.select().from(v).where(eq(v.id, consumed!.id))))[0]).toMatchObject({ orgId: own.orgId, workstationDeviceRef: device.id, status: 'verified', consumedIntentRef: consumedIntent, consumedAt });
  await expect(requireCallerVerification({ ...input, mode: 'consume' })).rejects.toMatchObject({ payload: { orgId: own.orgId } });
  await expect(requireCallerVerification({ ...input, intentId: consumedIntent, mode: 'consume' })).rejects.toMatchObject({ payload: { reason: 'target_rebound' } });
});

// ---------------------------------------------------------------------------
// Rollback, login observation, directory HTTP
// ---------------------------------------------------------------------------

it.each(['organization', 'system'] as const)('observation failure rolls back decision, receipt and effects in ambient %s context', async (scope) => {
  const f = await liveFixture();
  const own = f.families[0]!;
  const device = await liveDevice(own);
  const [command] = await sys(() => db.insert(deviceCommands).values({ deviceId: device.id, type: 'caller_verify', status: 'completed', payload: {}, result: { receipt: 'before' } }).returning());
  const decision = { verificationId: own.verification.id, decision: { kind: 'choice' as const, value: '42' }, principal: { osPrincipal: own.binding.osPrincipal!, osUsername: 'alex', upn: own.binding.upnSnapshot } };
  const context = { scope: 'organization' as const, orgId: own.orgId, accessibleOrgIds: [own.orgId], accessiblePartnerIds: [], currentPartnerId: f.env.partner.id, userId: f.env.user.id };
  const attempt = async () => {
    await db.update(deviceCommands).set({ result: { receipt: 'handled' } }).where(eq(deviceCommands.id, command!.id));
    expect((await applyDecision(decision)).status).toBe('verified');
    // Real database failure in the observation write, after the decision succeeded.
    await observeLogin({ orgId: own.orgId, contactId: own.contact.id, osPrincipal: own.binding.osPrincipal!, osUsername: 'x'.repeat(256), upn: own.binding.upnSnapshot });
  };
  await code(scope === 'system' ? sys(attempt) : withDbAccessContext(context, attempt), '22001');
  expect((await sys(() => db.select().from(v).where(eq(v.id, own.verification.id))))[0]).toMatchObject({ status: 'pending', decidedAt: null });
  expect((await sys(() => db.select().from(deviceCommands).where(eq(deviceCommands.id, command!.id))))[0]!.result).toEqual({ receipt: 'before' });
  expect(await sys(() => db.select().from(ticketComments).where(eq(ticketComments.ticketId, own.ticket.id)))).toEqual([]);
  expect(await sys(() => db.select().from(ticketOutbox).where(eq(ticketOutbox.ticketId, own.ticket.id)))).toEqual([]);
  expect(await sys(() => db.select().from(auditLogs).where(eq(auditLogs.resourceId, own.verification.id)))).toEqual([]);
  // Positive control proves the same path commits all three when observation succeeds.
  await withDbAccessContext(context, async () => {
    await db.update(deviceCommands).set({ result: { receipt: 'handled' } }).where(eq(deviceCommands.id, command!.id));
    await applyDecision(decision);
    await observeLogin({ orgId: own.orgId, contactId: own.contact.id, ...decision.principal });
  });
  expect((await sys(() => db.select().from(v).where(eq(v.id, own.verification.id))))[0]!.status).toBe('verified');
  expect((await sys(() => db.select().from(deviceCommands).where(eq(deviceCommands.id, command!.id))))[0]!.result).toEqual({ receipt: 'handled' });
  expect(await sys(() => db.select().from(ticketOutbox).where(eq(ticketOutbox.ticketId, own.ticket.id)))).toHaveLength(1);
});

it('independent login resolves only a unique existing binding in its own org', async () => {
  const upn = 'observed@example.com';
  const principal = { sid: 'S-1-5-21-987', username: 'alex', upn };
  await sys(() => db.update(b).set({ upnSnapshot: upn }).where(sql`${b.id} IN (${ba}::uuid, ${bb}::uuid)`));
  await withDbAccessContext(org(A), () => observeSessionPrincipal(A, 'host', 'alex', principal));
  expect((await sys(() => db.select().from(b).where(eq(b.id, ba))))[0]!.osPrincipal).toBe(principal.sid);
  expect((await sys(() => db.select().from(b).where(eq(b.id, bb))))[0]!.osPrincipal).toBe('sid:collision');
  // Same UPN in another org alone must never create or update a local binding.
  await sys(() => db.update(b).set({ upnSnapshot: 'different@example.com', osPrincipal: null }).where(eq(b.id, ba)));
  await withDbAccessContext(org(A), () => observeSessionPrincipal(A, 'host', 'alex', principal));
  expect((await sys(() => db.select().from(b).where(eq(b.id, ba))))[0]!.osPrincipal).toBeNull();
  // Two canonical identities in the same org sharing a UPN are ambiguous.
  await sys(() => db.update(b).set({ upnSnapshot: upn }).where(sql`${b.id} IN (${ba}::uuid, ${ba2}::uuid)`));
  await withDbAccessContext(org(A), () => observeSessionPrincipal(A, 'host', 'alex', principal));
  expect((await sys(() => db.select().from(b).where(eq(b.id, ba))))[0]!.osPrincipal).toBeNull();
  expect((await sys(() => db.select().from(b).where(eq(b.id, ba2))))[0]!.osPrincipal).toBeNull();
});

it('directory search returns W04 data envelope and enforces real route authorization', async () => {
  const f = await liveFixture('organization', false);
  const own = f.families[0]!;
  directoryRead.mockResolvedValue({ ok: true, kind: 'collection', items: [{ id: own.binding.entraOid, userPrincipalName: own.binding.upnSnapshot, displayName: 'Alex' }], truncated: false });
  const path = `/orgs/${own.orgId}/caller-verification-directory-users?search=alex`;
  const response = await f.request('GET', path);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toEqual({ data: { available: true, truncated: false, users: [{ entraTenantId: own.binding.entraTenantId, entraOid: own.binding.entraOid, upn: own.binding.upnSnapshot, displayName: 'Alex' }] } });
  expect((await f.request('GET', `/orgs/${f.families[2]!.orgId}/caller-verification-directory-users?search=alex`)).status).toBe(404);
  await getTestDb().update(organizationUsers).set({ siteIds: [f.env.site.id] }).where(eq(organizationUsers.userId, f.env.user.id));
  await clearPermissionCache(f.env.user.id);
  expect((await f.request('GET', path)).status).toBe(404);
  expect(directoryRead).toHaveBeenCalledTimes(1);
});

it('directory HTTP search reports unavailable and sanitizes failed reads', async () => {
  const f = await liveFixture('organization', false);
  const own = f.families[0]!;
  const path = `/orgs/${own.orgId}/caller-verification-directory-users?search=alex`;
  await sys(() => db.update(m365Connections).set({ status: 'revoked' }).where(eq(m365Connections.orgId, own.orgId)));
  const unavailable = await f.request('GET', path);
  expect(unavailable.status).toBe(200);
  expect(await unavailable.json()).toEqual({ data: { available: false, users: [], truncated: false } });
  expect(directoryRead).not.toHaveBeenCalled();
  await sys(() => db.update(m365Connections).set({ status: 'active' }).where(eq(m365Connections.orgId, own.orgId)));
  directoryRead.mockResolvedValue({ ok: false, message: 'private Graph failure' });
  const failed = await f.request('GET', path);
  expect(failed.status).toBe(400);
  expect(await failed.json()).toEqual({ code: 'directory_unavailable', error: 'Directory read unavailable' });
});

it.each(['complete', 'partial', 'failed', 'tenant-changed'] as const)('directory sync %s controls disappearance reconciliation', async (mode) => {
  const f = await liveFixture('organization', false);
  const own = f.families[0]!;
  const missing = f.families[1]!;
  const foreign = f.families[2]!;
  await sys(() => db.update(v).set({ status: 'verified', decidedAt: new Date() }).where(eq(v.id, missing.verification.id)));
  const usedAt = new Date();
  const intentId = randomUUID();
  const [used] = await sys(() => db.insert(v).values({ ...missing.verification, id: randomUUID(), status: 'verified', decidedAt: new Date(), consumedAt: usedAt, consumedIntentRef: intentId }).returning());
  directoryRead.mockImplementation(async (_auth: unknown, action: { type: string }) => {
    if (mode === 'failed') return { ok: false, message: 'private upstream error' };
    if (mode === 'tenant-changed') await sys(() => db.update(m365Connections).set({ tenantId: randomUUID() }).where(eq(m365Connections.orgId, own.orgId)));
    const resource = { id: own.binding.entraOid, userPrincipalName: own.binding.upnSnapshot, mail: own.contact.email, displayName: 'Alex' };
    return action.type === 'm365.user.get' ? { ok: true, kind: 'resource', resource } : { ok: true, kind: 'collection', items: [resource], truncated: mode === 'partial' };
  });
  const response = await f.request('POST', `/orgs/${own.orgId}/caller-verification-directory-sync`, { mappings: [{ contactId: own.contact.id, entraOid: own.binding.entraOid }] });
  expect(response.status, await response.clone().text()).toBe(mode === 'complete' || mode === 'partial' ? 200 : 400);
  if (response.status === 200) expect((await response.json()).data).toMatchObject({ imported: 1, complete: mode === 'complete', revoked: mode === 'complete' ? 1 : 0 });
  const [lost] = await sys(() => db.select().from(b).where(eq(b.id, missing.binding.id)));
  expect(lost!.revokedAt !== null).toBe(mode === 'complete');
  expect((await sys(() => db.select().from(v).where(eq(v.id, missing.verification.id))))[0]!.status).toBe(mode === 'complete' ? 'revoked' : 'verified');
  expect((await sys(() => db.select().from(b).where(eq(b.id, foreign.binding.id))))[0]!.revokedAt).toBeNull();
  expect((await sys(() => db.select().from(v).where(eq(v.id, used!.id))))[0]).toMatchObject({ status: 'verified', consumedAt: usedAt, consumedIntentRef: intentId });
});
