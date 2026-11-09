/**
 * Portal registration W4 (#11381) Task 9, plan D12: `password_mode = sso_only`
 * as a complete save flow, against real Postgres as breeze_app (forced RLS)
 * through the real MSP routes and the real portal login (Review Focus 4; spec
 * §5.11, inv. 11).
 *
 *  - The impact preview counts, per flipped org, the identity accounts whose
 *    hash a save clears and the stranded accounts (no identity) it lists.
 *  - The PATCH needs `?acknowledge=<impactDigest>` of the impact recomputed in
 *    its own transaction: missing or stale → 409 with the fresh impact, and
 *    nothing written.
 *  - With it, the policy upsert and the clearing commit together (a forced
 *    failure rolls back both), only identity accounts lose their hash and get
 *    an epoch bump, and a partner save touches only its own orgs.
 *  - A flip caused by a tenant proof clears nothing; the refusal at use holds.
 *  - Races with a concurrent self-link (two connections, no sleeps decide
 *    anything): a link that waits behind the save's row lock is not cleared,
 *    and an SSO re-invite that waits behind a committing link sees it.
 *
 * Seeding is superuser (getTestDb); every assertion that matters reads back
 * real rows. Sessions use the in-memory backend (PORTAL_USE_REDIS is false
 * under NODE_ENV=test).
 *
 * Run:
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalSsoOnly.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';

// A switch that makes the clear fail AFTER it ran, inside the save's savepoint;
// a gate that pauses the save just before it clears; and the ids each clear wrote.
const { forceClearFailure, clearGate, clearCalls } = vi.hoisted(() => ({
  forceClearFailure: { current: false },
  clearGate: { current: null as null | (() => Promise<void>) },
  clearCalls: [] as string[][],
}));
vi.mock('../../services/portalSsoOnly', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/portalSsoOnly')>();
  return {
    ...actual,
    clearPasswordsForSsoOnly: async (...args: Parameters<typeof actual.clearPasswordsForSsoOnly>) => {
      if (clearGate.current) await clearGate.current();
      const cleared = await actual.clearPasswordsForSsoOnly(...args);
      clearCalls.push(cleared.clearedUserIds);
      if (forceClearFailure.current) throw new Error('forced failure after the clear');
      return cleared;
    },
  };
});
vi.mock('../../services/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/email')>()),
  getEmailService: () => ({ sendPortalInvite: async () => undefined, sendPasswordReset: async () => undefined }),
}));

import { clientAiTenantMappings, portalAccessPolicies, portalUserIdentities, portalUsers } from '../../db/schema';
import { authMiddleware } from '../../middleware/auth';
import { registerPortalAccessPolicyRoutes } from '../../routes/orgPortalAccessPolicy';
import { registerOrgPortalUsersRoutes } from '../../routes/orgPortalUsers';
import { portalRoutes } from '../../routes/portal';
import { portalRateLimitBuckets, portalSessions } from '../../routes/portal/helpers';
import { createAccessToken } from '../../services/jwt';
import { __testOnly } from '../../services/portalAccessPolicy';
import { recordEntraTenantProof } from '../../services/portalEntraTenantProof';
import { ssoOnlyImpactDigest } from '../../services/portalSsoOnly';
import { entraIssuer, linkPortalUserIdentity, type IdentityExecutor } from '../../services/portalUserIdentities';
import { hashPassword } from '../../services/password';
import { createOrganization, createPartner, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'SsoOnlyPass1!';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

const msp = (() => {
  const a = new Hono();
  a.use('*', authMiddleware);
  registerPortalAccessPolicyRoutes(a);
  registerOrgPortalUsersRoutes(a);
  return a;
})();
const portal = (() => {
  const a = new Hono();
  a.route('/portal', portalRoutes);
  return a;
})();

type Env = Awaited<ReturnType<typeof setupTestEnvironment>>;

async function mfaTokenFor(env: Env): Promise<string> {
  return createAccessToken({
    sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: null, partnerId: env.partner.id,
    scope: 'partner', mfa: true, aep: 1, mep: 1, sid: 'it-sso-only',
  });
}

function call(token: string, method: string, path: string, body?: unknown) {
  return msp.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...JSON_HEADERS },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const orgPolicy = (orgId: string) => `/organizations/${orgId}/portal-access-policy`;
const PARTNER_POLICY = '/partners/me/portal-access-policy';

async function login(email: string, password: string, orgId: string) {
  return portal.request('/portal/auth/login', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email, password, orgId }),
  });
}

async function proveTenant(orgId: string): Promise<string> {
  const tenantId = randomUUID();
  await getTestDb().insert(clientAiTenantMappings).values({
    orgId, entraTenantId: tenantId, provenAt: new Date(), provenVia: 'proof_run',
    provenEvidence: { via: 'proof_run', adminOid: randomUUID(), runId: randomUUID() },
  });
  return tenantId;
}

async function seedPolicy(values: Partial<typeof portalAccessPolicies.$inferInsert>): Promise<void> {
  await getTestDb().insert(portalAccessPolicies).values(values);
}

let passwordHash: string;
async function seedAccount(orgId: string, email: string, over: Partial<typeof portalUsers.$inferInsert> = {}) {
  const [row] = await getTestDb().insert(portalUsers).values({
    orgId, email, passwordHash, authMethod: 'password', status: 'active', browserAccess: 'granted', ...over,
  }).returning({ id: portalUsers.id, authEpoch: portalUsers.authEpoch });
  return row!;
}

async function linkIdentity(orgId: string, portalUserId: string): Promise<void> {
  const tid = randomUUID();
  await getTestDb().insert(portalUserIdentities).values({
    orgId, portalUserId, provider: 'entra', issuer: entraIssuer(tid), subject: randomUUID(), entraTenantId: tid, linkedVia: 'jit',
  });
}

async function readAccount(id: string) {
  const [row] = await getTestDb().select({ passwordHash: portalUsers.passwordHash, authEpoch: portalUsers.authEpoch })
    .from(portalUsers).where(eq(portalUsers.id, id));
  return row!;
}

async function orgPolicyRow(orgId: string) {
  const [row] = await getTestDb().select({ entraEnabled: portalAccessPolicies.entraEnabled, passwordMode: portalAccessPolicies.passwordMode })
    .from(portalAccessPolicies).where(eq(portalAccessPolicies.orgId, orgId));
  return row ?? null;
}

async function partnerPolicyRow(partnerId: string) {
  const [row] = await getTestDb().select({ entraEnabled: portalAccessPolicies.entraEnabled, passwordMode: portalAccessPolicies.passwordMode })
    .from(portalAccessPolicies)
    .where(and(isNull(portalAccessPolicies.orgId), eq(portalAccessPolicies.partnerId, partnerId)));
  return row ?? null;
}

/**
 * One partner-admin org with a proven tenant, Microsoft on (org override), and
 * the five account shapes the impact distinguishes.
 */
async function orgWithAccounts() {
  const env = await setupTestEnvironment({ scope: 'partner' });
  const token = await mfaTokenFor(env);
  const orgId = env.organization.id;
  await proveTenant(orgId);
  await seedPolicy({ orgId, entraEnabled: true });
  const linked = await seedAccount(orgId, 'a-linked@acme.example');          // identity + password → cleared
  await linkIdentity(orgId, linked.id);
  const strandedActive = await seedAccount(orgId, 'b-stranded@acme.example'); // no identity → stranded, keeps hash
  const strandedInvited = await seedAccount(orgId, 'c-invited@acme.example', { status: 'invited', passwordHash: null });
  const disabled = await seedAccount(orgId, 'd-disabled@acme.example', { status: 'disabled' }); // neither
  const addin = await seedAccount(orgId, 'e-addin@acme.example', { authMethod: 'entra', browserAccess: 'none', passwordHash: null });
  await linkIdentity(orgId, addin.id);
  return { env, token, orgId, linked, strandedActive, strandedInvited, disabled, addin };
}

async function previewOrg(token: string, orgId: string, patch: Record<string, unknown>) {
  const res = await call(token, 'POST', `${orgPolicy(orgId)}/sso-only-impact`, patch);
  expect(res.status).toBe(200);
  return (await res.json()).data as {
    flips: Array<{ orgId: string; orgName: string; passwordsToClear: number; strandedTotal: number }>;
    impactDigest: string;
    stranded: { items: Array<{ portalUserId: string; email: string; status: string }>; total: number };
  };
}

// ── Races with a self-link (two connections) ────────────────────────────────

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * The person's self-link (portalOidc/accountResolution.ts linkSignedIn) on its
 * OWN connection: lock the account row, then the real linkPortalUserIdentity
 * (identity insert + row update, no epoch bump). `hold` keeps the transaction
 * open after the link until it resolves; `linked` resolves once the link's
 * writes are in (uncommitted while held).
 */
async function selfLink(orgId: string, portalUserId: string, hold?: Promise<void>) {
  const client = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
  const [backend] = await client<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  const linked = deferred();
  const done = drizzle(client).transaction(async (tx) => {
    await tx.select({ id: portalUsers.id }).from(portalUsers)
      .where(and(eq(portalUsers.id, portalUserId), eq(portalUsers.orgId, orgId)))
      .for('update');
    const link = await linkPortalUserIdentity(tx as unknown as IdentityExecutor, {
      orgId, portalUserId, provider: 'entra', tid: randomUUID(), oid: randomUUID(),
      linkedVia: 'self_link', clearPasswordHash: false, now: new Date(),
    });
    if (link.kind !== 'linked') throw new Error(`self-link refused: ${link.kind}`);
    linked.resolve();
    await hold;
  }).finally(() => client.end({ timeout: 1 }));
  return { pid: backend!.pid, linked: linked.promise, done };
}

async function backendIsBlocked(pid: number): Promise<boolean> {
  const [row] = await getTestDb().execute<{ blocked: boolean }>(
    sql`SELECT cardinality(pg_catalog.pg_blocking_pids(${pid})) > 0 AS blocked`,
  );
  return Boolean(row?.blocked);
}

/** `pid` waits on a lock ('blocked') or `done` settles first ('finished'). Polls; no sleep decides. */
async function blockedOrFinished(pid: number, done: Promise<unknown>): Promise<'blocked' | 'finished'> {
  let finished = false;
  done.then(() => { finished = true; }, () => { finished = true; });
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (finished) return 'finished';
    if (await backendIsBlocked(pid)) return 'blocked';
    if (Date.now() > deadline) throw new Error(`backend ${pid} neither blocked nor finished`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Some backend of this database waits on a lock `blockerPid` holds. */
async function untilBlockedBy(blockerPid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await getTestDb().execute<{ waiting: number }>(sql`
      SELECT count(*)::int AS waiting FROM pg_catalog.pg_stat_activity
       WHERE datname = current_database() AND ${blockerPid} = ANY(pg_catalog.pg_blocking_pids(pid))`);
    if ((row?.waiting ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error(`nothing blocked behind backend ${blockerPid}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function readState(id: string) {
  const [row] = await getTestDb().select({ status: portalUsers.status, passwordHash: portalUsers.passwordHash, authEpoch: portalUsers.authEpoch })
    .from(portalUsers).where(eq(portalUsers.id, id));
  const identities = await getTestDb().select({ id: portalUserIdentities.id }).from(portalUserIdentities)
    .where(eq(portalUserIdentities.portalUserId, id));
  return { ...row!, identities: identities.length };
}

beforeEach(async () => {
  passwordHash ??= await hashPassword(PASSWORD);
  __testOnly.setCapabilities({ entra: true, google: false, selfRegistration: false });
  forceClearFailure.current = false;
  clearGate.current = null;
  clearCalls.length = 0;
  portalSessions.clear();
  portalRateLimitBuckets.clear();
});
afterEach(() => __testOnly.setCapabilities(null));

describe('sso_only impact (computeSsoOnlyFlips on real rows)', () => {
  it('computeSsoOnlyFlips: org sso_only with entra on and proven → one flip; already sso_only → none', async () => {
    const s = await orgWithAccounts();
    const preview = await previewOrg(s.token, s.orgId, { passwordMode: 'sso_only' });
    expect(preview.flips).toEqual([{
      orgId: s.orgId, orgName: s.env.organization.name, passwordsToClear: 1, strandedTotal: 2,
    }]);
    expect(preview.impactDigest).toBe(ssoOnlyImpactDigest(preview.flips));
    expect(preview.stranded.total).toBe(2);
    expect(preview.stranded.items.map((i) => [i.portalUserId, i.status])).toEqual([
      [s.strandedActive.id, 'active'],
      [s.strandedInvited.id, 'invited'],
    ]);

    const saved = await call(s.token, 'PATCH', `${orgPolicy(s.orgId)}?acknowledge=${preview.impactDigest}`, { passwordMode: 'sso_only' });
    expect(saved.status).toBe(200);
    // Already effectively sso_only: nothing more to flip.
    expect((await previewOrg(s.token, s.orgId, { passwordMode: 'sso_only' })).flips).toEqual([]);
  });

  it('computeSsoOnlyFlips: partner entra on flips every inheriting org that already holds an sso_only override in fallback', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const token = await mfaTokenFor(env);
    const fallback = env.organization;                                                   // proven, sso_only override in fallback
    const inheriting = await createOrganization({ partnerId: env.partner.id });         // proven, no override
    const unproven = await createOrganization({ partnerId: env.partner.id });           // sso_only override, no proof
    await proveTenant(fallback.id);
    await proveTenant(inheriting.id);
    await seedPolicy({ orgId: fallback.id, passwordMode: 'sso_only' });
    await seedPolicy({ orgId: unproven.id, passwordMode: 'sso_only' });
    const linked = await seedAccount(fallback.id, 'linked@fallback.example');
    await linkIdentity(fallback.id, linked.id);

    const res = await call(token, 'POST', `${PARTNER_POLICY}/sso-only-impact`, { entraEnabled: true });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.flips).toEqual([{ orgId: fallback.id, orgName: fallback.name, passwordsToClear: 1, strandedTotal: 0 }]);
    expect(data.impactDigest).toBe(ssoOnlyImpactDigest(data.flips));
  });
});

describe('sso_only save (PATCH with acknowledge)', () => {
  it('PATCH without acknowledge → 409 with impact and nothing written', async () => {
    const s = await orgWithAccounts();
    const res = await call(s.token, 'PATCH', orgPolicy(s.orgId), { passwordMode: 'sso_only' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('PORTAL_ACCESS_POLICY_SSO_ONLY_CONFIRM_REQUIRED');
    expect(body.impact.flips).toEqual([expect.objectContaining({ orgId: s.orgId, passwordsToClear: 1, strandedTotal: 2 })]);
    expect(body.impact.impactDigest).toBe(ssoOnlyImpactDigest(body.impact.flips));

    expect(await orgPolicyRow(s.orgId)).toEqual({ entraEnabled: true, passwordMode: null });
    expect(await readAccount(s.linked.id)).toEqual({ passwordHash, authEpoch: s.linked.authEpoch });
  });

  it('saving sso_only clears hashes only for identity accounts and lists the stranded', async () => {
    const s = await orgWithAccounts();
    // A live password session for the linked account, from before the save.
    const before = await login('a-linked@acme.example', PASSWORD, s.orgId);
    expect(before.status).toBe(200);

    const preview = await previewOrg(s.token, s.orgId, { passwordMode: 'sso_only' });
    const res = await call(s.token, 'PATCH', `${orgPolicy(s.orgId)}?acknowledge=${preview.impactDigest}`, { passwordMode: 'sso_only' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.effective.passwordMode).toEqual({ value: 'sso_only', source: 'org' });

    // Identity account: hash gone, epoch bumped (its password session and tokens die durably).
    expect(await readAccount(s.linked.id)).toEqual({ passwordHash: null, authEpoch: s.linked.authEpoch + 1 });
    // Stranded and the rest: untouched.
    expect(await readAccount(s.strandedActive.id)).toEqual({ passwordHash, authEpoch: s.strandedActive.authEpoch });
    expect(await readAccount(s.strandedInvited.id)).toEqual({ passwordHash: null, authEpoch: s.strandedInvited.authEpoch });
    expect(await readAccount(s.disabled.id)).toEqual({ passwordHash, authEpoch: s.disabled.authEpoch });
    expect(await readAccount(s.addin.id)).toEqual({ passwordHash: null, authEpoch: s.addin.authEpoch });

    const stranded = await call(s.token, 'GET', `${orgPolicy(s.orgId)}/stranded`);
    expect(stranded.status).toBe(200);
    expect((await stranded.json()).data).toEqual({
      items: [
        { portalUserId: s.strandedActive.id, email: 'b-stranded@acme.example', name: null, status: 'active' },
        { portalUserId: s.strandedInvited.id, email: 'c-invited@acme.example', name: null, status: 'invited' },
      ],
      total: 2,
    });
    // The stranded account keeps its hash but cannot use it under sso_only.
    expect((await login('b-stranded@acme.example', PASSWORD, s.orgId)).status).toBe(401);
  });

  it('PATCH with a stale digest (a new identity account appeared since the preview) → 409 with the fresh digest', async () => {
    const s = await orgWithAccounts();
    const preview = await previewOrg(s.token, s.orgId, { passwordMode: 'sso_only' });
    // The stranded active account links Microsoft after the MSP opened the dialog.
    await linkIdentity(s.orgId, s.strandedActive.id);

    const stale = await call(s.token, 'PATCH', `${orgPolicy(s.orgId)}?acknowledge=${preview.impactDigest}`, { passwordMode: 'sso_only' });
    expect(stale.status).toBe(409);
    const { impact } = await stale.json();
    expect(impact.flips).toEqual([expect.objectContaining({ orgId: s.orgId, passwordsToClear: 2, strandedTotal: 1 })]);
    expect(impact.impactDigest).not.toBe(preview.impactDigest);
    expect(await orgPolicyRow(s.orgId)).toEqual({ entraEnabled: true, passwordMode: null });
    expect((await readAccount(s.linked.id)).passwordHash).toBe(passwordHash);

    const fresh = await call(s.token, 'PATCH', `${orgPolicy(s.orgId)}?acknowledge=${impact.impactDigest}`, { passwordMode: 'sso_only' });
    expect(fresh.status).toBe(200);
    expect((await readAccount(s.strandedActive.id)).passwordHash).toBeNull();
  });

  it('PATCH with acknowledge commits policy + clearing together; a forced failure rolls back both', async () => {
    const s = await orgWithAccounts();
    const preview = await previewOrg(s.token, s.orgId, { passwordMode: 'sso_only' });

    forceClearFailure.current = true;
    const failed = await call(s.token, 'PATCH', `${orgPolicy(s.orgId)}?acknowledge=${preview.impactDigest}`, { passwordMode: 'sso_only' });
    expect(failed.status).toBe(500);
    // Neither the policy nor the clear survived.
    expect(await orgPolicyRow(s.orgId)).toEqual({ entraEnabled: true, passwordMode: null });
    expect(await readAccount(s.linked.id)).toEqual({ passwordHash, authEpoch: s.linked.authEpoch });

    forceClearFailure.current = false;
    const ok = await call(s.token, 'PATCH', `${orgPolicy(s.orgId)}?acknowledge=${preview.impactDigest}`, { passwordMode: 'sso_only' });
    expect(ok.status).toBe(200);
    expect(await orgPolicyRow(s.orgId)).toEqual({ entraEnabled: true, passwordMode: 'sso_only' });
    expect(await readAccount(s.linked.id)).toEqual({ passwordHash: null, authEpoch: s.linked.authEpoch + 1 });
  });

  it('a flip caused by a proof (no PATCH) clears no hashes but password login is refused', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    // sso_only stored, but no proven tenant: Microsoft masked, so password is still allowed (fallback).
    await seedPolicy({ orgId: org.id, entraEnabled: true, passwordMode: 'sso_only' });
    const linked = await seedAccount(org.id, 'proof@acme.example');
    await linkIdentity(org.id, linked.id);
    expect((await login('proof@acme.example', PASSWORD, org.id)).status).toBe(200);

    await recordEntraTenantProof({
      orgId: org.id, tenantId: randomUUID(), via: 'proof_run',
      evidence: { adminOid: randomUUID(), runId: randomUUID() }, provenByUserId: null,
    });

    // Effective sso_only now, through a proof: no hash cleared, no epoch bumped (inv. 11) …
    expect(await readAccount(linked.id)).toEqual({ passwordHash, authEpoch: linked.authEpoch });
    // … and the refusal at use is the control: the same 401 as a wrong password.
    const wrong = await login('proof@acme.example', 'WrongSsoOnly9!', org.id);
    const refused = await login('proof@acme.example', PASSWORD, org.id);
    expect(refused.status).toBe(401);
    expect(await refused.text()).toBe(await wrong.text());
  });

  it('partner PATCH with acknowledge clears across its orgs only (another partner untouched)', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const token = await mfaTokenFor(env);
    const orgA = env.organization;
    const orgB = await createOrganization({ partnerId: env.partner.id });
    const orgUnproven = await createOrganization({ partnerId: env.partner.id });
    await proveTenant(orgA.id);
    await proveTenant(orgB.id);
    const a = await seedAccount(orgA.id, 'a@one.example');
    const b = await seedAccount(orgB.id, 'b@one.example');
    const u = await seedAccount(orgUnproven.id, 'u@one.example');
    for (const [orgId, acct] of [[orgA.id, a], [orgB.id, b], [orgUnproven.id, u]] as const) await linkIdentity(orgId, acct.id);

    // Another partner's org, proven, with an identity account: never in scope.
    const other = await createPartner();
    const otherOrg = await createOrganization({ partnerId: other.id });
    await proveTenant(otherOrg.id);
    const x = await seedAccount(otherOrg.id, 'x@two.example');
    await linkIdentity(otherOrg.id, x.id);

    const patch = { entraEnabled: true, passwordMode: 'sso_only' };
    const refused = await call(token, 'PATCH', PARTNER_POLICY, patch);
    expect(refused.status).toBe(409);
    const { impact } = await refused.json();
    expect(impact.flips.map((f: { orgId: string }) => f.orgId).sort()).toEqual([orgA.id, orgB.id].sort());
    expect(await partnerPolicyRow(env.partner.id)).toBeNull();

    const saved = await call(token, 'PATCH', `${PARTNER_POLICY}?acknowledge=${impact.impactDigest}`, patch);
    expect(saved.status).toBe(200);
    expect(await partnerPolicyRow(env.partner.id)).toEqual({ entraEnabled: true, passwordMode: 'sso_only' });
    expect(await readAccount(a.id)).toEqual({ passwordHash: null, authEpoch: a.authEpoch + 1 });
    expect(await readAccount(b.id)).toEqual({ passwordHash: null, authEpoch: b.authEpoch + 1 });
    // Unproven org: Microsoft masked, sso_only falls back — not flipped, not cleared.
    expect(await readAccount(u.id)).toEqual({ passwordHash, authEpoch: u.authEpoch });
    // The other partner's account is untouched.
    expect(await readAccount(x.id)).toEqual({ passwordHash, authEpoch: x.authEpoch });
  });
});

describe('races with a concurrent self-link', () => {
  it('a self-link blocked behind the save\'s row lock is not cleared; the save writes exactly the acknowledged rows', async () => {
    const s = await orgWithAccounts();
    const preview = await previewOrg(s.token, s.orgId, { passwordMode: 'sso_only' });
    expect(preview.flips).toEqual([expect.objectContaining({ passwordsToClear: 1, strandedTotal: 2 })]);

    // Pause the acknowledged save after its impact check, just before it clears.
    const atClear = deferred();
    const release = deferred();
    clearGate.current = async () => { atClear.resolve(); await release.promise; };
    const saving = call(s.token, 'PATCH', `${orgPolicy(s.orgId)}?acknowledge=${preview.impactDigest}`, { passwordMode: 'sso_only' });
    let state: 'blocked' | 'finished' | undefined;
    try {
      await atClear.promise;
      // The account the MSP saw as stranded links Microsoft now, from its own session.
      const link = await selfLink(s.orgId, s.strandedActive.id);
      try {
        state = await blockedOrFinished(link.pid, link.done);
      } finally {
        release.resolve();
      }
      expect((await saving).status).toBe(200);
      await link.done;
    } finally {
      release.resolve();
    }

    // The save held the account's row lock, so the link waited for its commit …
    expect(state).toBe('blocked');
    // … and the save wrote exactly what the MSP acknowledged: one hash, the linked account's.
    expect(clearCalls).toEqual([[s.linked.id]]);
    expect(clearCalls[0]).toHaveLength(preview.flips[0]!.passwordsToClear);
    expect(await readState(s.linked.id)).toEqual({ status: 'active', passwordHash: null, authEpoch: s.linked.authEpoch + 1, identities: 1 });
    // The stranded account linked after all, and keeps its hash and epoch (it
    // sheds the hash on its first Microsoft sign-in, D12 lazy convergence).
    expect(await readState(s.strandedActive.id)).toEqual({ status: 'active', passwordHash, authEpoch: s.strandedActive.authEpoch, identities: 1 });
  });

  it('a re-invite racing a self-link that commits while it waits for the row lock → not_stranded, nothing written', async () => {
    const s = await orgWithAccounts();
    // Password sign-in off: the active stranded account is a re-invite candidate.
    await getTestDb().update(portalAccessPolicies).set({ passwordMode: 'sso_only' }).where(eq(portalAccessPolicies.orgId, s.orgId));

    const commit = deferred();
    const link = await selfLink(s.orgId, s.strandedActive.id, commit.promise);
    let inviting: Promise<Response> | undefined;
    try {
      await link.linked; // identity inserted, row updated: not committed yet
      inviting = Promise.resolve(call(s.token, 'POST', `/organizations/${s.orgId}/portal-users/sso-invite`, { portalUserIds: [s.strandedActive.id] }));
      // The re-invite reaches the account row while the link still holds it.
      await untilBlockedBy(link.pid);
    } finally {
      commit.resolve();
    }
    await link.done;
    const res = await inviting!;

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([{ portalUserId: s.strandedActive.id, result: 'not_stranded' }]);
    // Not moved to `invited` (normal SSO would refuse it, invite acceptance its identity).
    expect(await readState(s.strandedActive.id)).toEqual({ status: 'active', passwordHash, authEpoch: s.strandedActive.authEpoch, identities: 1 });
  });
});
