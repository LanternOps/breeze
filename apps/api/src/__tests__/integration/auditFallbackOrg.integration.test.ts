/**
 * The generic audit fallback (index.ts) writes a row for a mutating request
 * whose handler wrote none of its own. It needs an org id for that row, and
 * `resolveFallbackOrgId` (services/auditFallbackOrg.ts) supplies it.
 *
 * Why this runs against real Postgres: the fallback runs AFTER the route has
 * returned, i.e. after authMiddleware's request transaction has closed. A
 * resource lookup issued there without re-entering the caller's DB context
 * runs as `breeze_app` with scope 'none', which RLS answers with zero rows —
 * a mocked `db` cannot show that. These tests pin both halves: the lookup
 * finds the caller's own rows, and never another tenant's.
 */
import './setup';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { transpile } from 'typescript';
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));

import { auditLogs, devices, users } from '../../db/schema';
import { invoiceSettingsRoutes } from '../../routes/invoices/settings';
import { writeAuditEvent } from '../../services/auditEvents';
import { getAuditRetryQueueDepth, runWithAuditRequestTracking } from '../../services/auditService';
import { authMiddleware } from '../../middleware/auth';
import { resolveFallbackOrgId } from '../../services/auditFallbackOrg';
import { createAccessToken } from '../../services/jwt';
import type { AuthContext } from '../../middleware/auth';
import { createOrganization, createPartner, createSite, setupTestEnvironment } from './db-utils';
import { awaitAuditRows } from './auditWait';
import { getTestDb } from './setup';

// The fallback middleware and its helpers live in index.ts, which cannot be
// imported (it boots servers and workers). Execute the real source instead —
// the same technique index.auditFallback.test.ts uses — wired to the real
// audit writer and the real org resolver.
const indexSource = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
const helpersStart = indexSource.indexOf('const FALLBACK_AUDIT_EXCLUDE_PREFIXES');
const helpersEnd = indexSource.indexOf('// Generic partner status guard');
const methodAt = indexSource.indexOf('  const method = c.req.method.toUpperCase();', helpersEnd);
const mwStart = indexSource.lastIndexOf("api.use('*', ", methodAt) + "api.use('*', ".length;
const mwEnd = indexSource.indexOf('\n});', methodAt) + 2;
if (helpersStart < 0 || helpersEnd < helpersStart || methodAt < 0) {
  throw new Error('index.ts layout changed: cannot locate the fallback audit middleware');
}
const fallbackAudit = new Function('writeAuditEvent', 'runWithAuditRequestTracking', 'resolveFallbackOrgId',
  transpile(`${indexSource.slice(helpersStart, helpersEnd)}\nreturn ${indexSource.slice(mwStart, mwEnd)};`),
)(writeAuditEvent, runWithAuditRequestTracking, resolveFallbackOrgId) as MiddlewareHandler;

// A mutating route that writes no audit of its own and whose org is not in
// the URL — the shape of a partner-level config write (catalog, templates) or
// a body-targeted create. Real authMiddleware, so the request runs in the
// caller's real DB access context as breeze_app.
const PROBE_PATH = '/api/v1/catalog/__fallback-probe';

function buildApp() {
  const api = new Hono();
  api.use('*', fallbackAudit);
  api.post('/catalog/__fallback-probe', authMiddleware, (c) => c.json({ data: { ok: true } }, 201));
  api.route('/', invoiceSettingsRoutes);
  return new Hono().route('/api/v1', api);
}

async function seedPartnerWithTwoOrgs() {
  const env = await setupTestEnvironment({ scope: 'partner' });
  const orgB = await createOrganization({ partnerId: env.partner.id });
  const foreignPartner = await createPartner();
  const foreignOrg = await createOrganization({ partnerId: foreignPartner.id });
  // setupTestEnvironment mints mfa:false; billing-settings sits behind requireMfa().
  const token = await createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: null,
    partnerId: env.partner.id,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });
  return { env, orgA: env.organization, orgB, foreignOrg, token };
}

async function fallbackRowsFor(orgId: string) {
  return getTestDb()
    .select({ orgId: auditLogs.orgId, action: auditLogs.action, details: auditLogs.details, result: auditLogs.result })
    .from(auditLogs)
    .where(and(eq(auditLogs.orgId, orgId), sql`${auditLogs.details}->>'fallback' = 'true'`));
}

async function probeRowsFor(actorId: string) {
  return getTestDb()
    .select({
      id: auditLogs.id,
      orgId: auditLogs.orgId,
      actorId: auditLogs.actorId,
      action: auditLogs.action,
      details: auditLogs.details,
      result: auditLogs.result,
      checksum: auditLogs.checksum,
    })
    .from(auditLogs)
    .where(and(eq(auditLogs.actorId, actorId), sql`${auditLogs.details}->>'path' = ${PROBE_PATH}`));
}

async function chainEntryFor(auditId: string) {
  const rows = await getTestDb().execute(sql`
    SELECT org_id, chain_checksum FROM audit_log_chain WHERE audit_id = ${auditId}
  `);
  return rows as unknown as Array<{ org_id: string | null; chain_checksum: string | null }>;
}

async function postProbe(token: string) {
  return buildApp().request(PROBE_PATH, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgId: randomUUID(), name: 'body-only target' }),
  });
}

async function seedDevice(orgId: string) {
  const site = await createSite({ orgId });
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId: site.id,
    agentId: randomUUID(),
    hostname: `audit-fallback-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'offline',
  }).returning({ id: devices.id });
  if (!device) throw new Error('failed to seed device');
  return device.id;
}

function partnerAuth(partnerId: string, userId: string, orgIds: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'audit-fallback@example.test', name: 'Audit Fallback', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: orgIds,
    partnerOrgAccess: 'all',
    orgCondition: () => undefined,
    canAccessOrg: (orgId: string) => orgIds.includes(orgId),
  } as AuthContext;
}

function fakeContext(auth: AuthContext): Context {
  return { get: (key: string) => (key === 'auth' ? auth : undefined), req: { query: () => undefined } } as unknown as Context;
}

describe('fallback audit org resolution (real database)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records the fallback row in the targeted org for a multi-org partner caller', async () => {
    const { orgA, orgB, token } = await seedPartnerWithTwoOrgs();

    const res = await buildApp().request(`/api/v1/orgs/${orgB.id}/billing-settings`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taxId: 'AUDIT-FALLBACK-1' }),
    });
    expect(res.status).toBe(200);

    const rows = await awaitAuditRows(() => fallbackRowsFor(orgB.id), 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: orgB.id,
      action: 'api.patch.orgs.:id.billing-settings',
      result: 'success',
      details: expect.objectContaining({
        path: `/api/v1/orgs/${orgB.id}/billing-settings`,
        method: 'PATCH',
        statusCode: 200,
        fallback: true,
      }),
    });
    expect(await fallbackRowsFor(orgA.id)).toHaveLength(0);
  });

  it('writes nothing into another tenant\'s log when the path names a foreign org', async () => {
    const { foreignOrg, token } = await seedPartnerWithTwoOrgs();

    const res = await buildApp().request(`/api/v1/orgs/${foreignOrg.id}/billing-settings`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taxId: 'AUDIT-FALLBACK-2' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    // An absence cannot be polled for (see auditWait.ts); give a stray
    // fire-and-forget write time to land before asserting there is none.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await fallbackRowsFor(foreignOrg.id)).toHaveLength(0);
  });

  it('finds a device in the caller\'s own org under the caller\'s DB context, and never a foreign one', async () => {
    const { env, orgA, orgB, foreignOrg } = await seedPartnerWithTwoOrgs();
    const ownDevice = await seedDevice(orgB.id);
    const foreignDevice = await seedDevice(foreignOrg.id);
    const auth = partnerAuth(env.partner.id, env.user.id, [orgA.id, orgB.id]);

    await expect(resolveFallbackOrgId(fakeContext(auth), `/api/v1/devices/${ownDevice}`)).resolves.toBe(orgB.id);
    await expect(resolveFallbackOrgId(fakeContext(auth), `/api/v1/devices/${foreignDevice}`)).resolves.toBeNull();

    // The same lookup with the app-level access check disabled: only RLS on
    // the caller's DB context now stands between it and the foreign device.
    const rlsOnly = { ...auth, canAccessOrg: () => true } as AuthContext;
    await expect(resolveFallbackOrgId(fakeContext(rlsOnly), `/api/v1/devices/${ownDevice}`)).resolves.toBe(orgB.id);
    await expect(resolveFallbackOrgId(fakeContext(rlsOnly), `/api/v1/devices/${foreignDevice}`)).resolves.toBeNull();
  });
});

describe('fallback audit rows that resolve no org (real database, breeze_app)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function expectLandedAndSealed(actorId: string, expectedOrgId: string | null) {
    const rows = await awaitAuditRows(() => probeRowsFor(actorId), 1);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.orgId).toBe(expectedOrgId);
    expect(row.result).toBe('success');
    expect(row.action).toBe('api.post.catalog.__fallback-probe');
    expect(row.details).toEqual(expect.objectContaining({ fallback: true, path: PROBE_PATH, statusCode: 201 }));
    // The request body is never copied into the row.
    expect(JSON.stringify(row.details)).not.toContain('body-only target');
    // The content-checksum trigger ran and the commit-time chain seal
    // accepted the row (a NULL-org row joins the shared NULL-org chain).
    expect(row.checksum).toBeTruthy();
    const chain = await chainEntryFor(row.id);
    expect(chain).toHaveLength(1);
    expect(chain[0]!.org_id ?? null).toBe(expectedOrgId);
    expect(chain[0]!.chain_checksum).toBeTruthy();
    // Nothing failed and got parked for a silent retry.
    expect(getAuditRetryQueueDepth()).toBe(0);
    return row;
  }

  it('records a partner-level (NULL-org) row for a multi-org partner user', async () => {
    const { env, token } = await seedPartnerWithTwoOrgs();
    const res = await postProbe(token);
    expect(res.status).toBe(201);
    const row = await expectLandedAndSealed(env.user.id, null);
    expect(row.details).toEqual(expect.objectContaining({ partnerId: env.partner.id }));
  });

  it('records an org-scope user\'s body-targeted write under that user\'s org', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const res = await postProbe(env.token);
    expect(res.status).toBe(201);
    const row = await expectLandedAndSealed(env.user.id, env.organization.id);
    expect(row.details).not.toHaveProperty('partnerId');
  });

  it('records a NULL-org row for a platform admin', async () => {
    const env = await setupTestEnvironment({ scope: 'system' });
    await getTestDb().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, env.user.id));
    const res = await postProbe(env.token);
    expect(res.status).toBe(201);
    const row = await expectLandedAndSealed(env.user.id, null);
    expect(row.details).not.toHaveProperty('partnerId');
  });
});
