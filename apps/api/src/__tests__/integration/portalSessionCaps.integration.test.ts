/**
 * Portal registration W4 (#11381), Task 6: entra browser sessions against real
 * Postgres as breeze_app through the real portal router (plan D9; Review
 * Focus 1 and 4; spec §5.11, §6 inv. 9).
 *
 * An entra session is minted by the shared `mintPortalBrowserSession` (the OIDC
 * callback's mint) pinned to the org's proven tenant. Every request re-resolves
 * the policy, so:
 * - lowering `ssoSessionMaxHours` ends an older session on its next request;
 * - a change of the org's proven tenant ends sessions pinned to the old one;
 * - turning Microsoft off ends every entra session;
 * - an entra session never passes a password-only policy, nor a password
 *   session an `sso_only` one.
 *
 * Proofs, mappings and policy rows are seeded as superuser (their write paths
 * are other suites'). Sessions use the in-memory backend (PORTAL_USE_REDIS is
 * false under NODE_ENV=test); the Redis payload is pinned in
 * routes/portal/auth.sessionMint.test.ts.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { clientAiTenantMappings, portalAccessPolicies, portalUserIdentities, portalUsers } from '../../db/schema';
import { clientAiAuthMiddleware } from '../../middleware/clientAiAuth';
import { CLIENT_AI_REDIS_KEYS, CLIENT_AI_SESSION_TTL_SECONDS } from '../../routes/clientAi/schemas';
import { portalRoutes } from '../../routes/portal';
import { mintPortalBrowserSession, type PortalSessionMethod } from '../../routes/portal/browserSession';
import { portalRateLimitBuckets, portalSessions } from '../../routes/portal/helpers';
import { __testOnly } from '../../services/portalAccessPolicy';
import { recordEntraTenantProof } from '../../services/portalEntraTenantProof';
import { hashPassword } from '../../services/password';
import { entraIssuer } from '../../services/portalUserIdentities';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb, getTestRedis } from './setup';

const HOUR_MS = 3_600_000;
const INVALID = { error: 'Invalid or expired session' };

const app = (() => {
  const a = new Hono();
  a.route('/portal', portalRoutes);
  // The mint is exercised exactly as a sign-in route calls it.
  a.post('/test/mint', async (c) => c.json(await mintPortalBrowserSession(c, await c.req.json())));
  return a;
})();

const profile = (token: string) => app.request('/portal/profile', { headers: { Authorization: `Bearer ${token}` } });

async function mint(input: { portalUserId: string; orgId: string; authEpoch: number; method: PortalSessionMethod; entraTenantId?: string }) {
  const res = await app.request('/test/mint', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  expect(res.status).toBe(200);
  return (await res.json() as { token: string }).token;
}

/** Superuser seeds: bypass RLS (the policy write path and the proof service are other suites'). */
async function seedPolicy(values: Partial<typeof portalAccessPolicies.$inferInsert>) {
  await getTestDb().insert(portalAccessPolicies).values(values);
}
async function setOrgPolicy(orgId: string, values: Partial<typeof portalAccessPolicies.$inferInsert>) {
  await getTestDb().update(portalAccessPolicies).set(values).where(eq(portalAccessPolicies.orgId, orgId));
}
async function proveTenant(orgId: string, tenantId: string) {
  await getTestDb().insert(clientAiTenantMappings).values({
    orgId, entraTenantId: tenantId,
    provenAt: new Date(), provenVia: 'proof_run', provenEvidence: { via: 'proof_run', adminOid: randomUUID(), runId: randomUUID() },
  });
}

/** An org with a proven tenant, an org policy row, and one active browser account. */
async function setup(policy: Partial<typeof portalAccessPolicies.$inferInsert>) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const tenantId = randomUUID();
  await proveTenant(org.id, tenantId);
  await seedPolicy({ orgId: org.id, ...policy });
  const [user] = await getTestDb().insert(portalUsers).values({
    orgId: org.id, email: `caps-${randomUUID()}@acme.example`, passwordHash: await hashPassword('PortalCapsPass1!'),
    authMethod: 'password', status: 'active', browserAccess: 'granted',
  }).returning({ id: portalUsers.id, authEpoch: portalUsers.authEpoch });
  const session = { portalUserId: user!.id, orgId: org.id, authEpoch: user!.authEpoch };
  return { orgId: org.id, tenantId, session };
}

/** Backdate an in-memory session's mint time (the only clock the cap reads). */
function ageSession(token: string, ageMs: number) {
  const stored = portalSessions.get(token)!;
  portalSessions.set(token, { ...stored, createdAt: new Date(Date.now() - ageMs) });
}

async function expectRefusedAndPurged(token: string) {
  const res = await profile(token);
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual(INVALID);
  expect(portalSessions.has(token)).toBe(false);
}

beforeEach(() => {
  __testOnly.setCapabilities({ entra: true, google: false, selfRegistration: false });
  portalSessions.clear();
  portalRateLimitBuckets.clear();
});

afterEach(() => __testOnly.setCapabilities(null));

describe('entra browser sessions: tenant pin and absolute cap (real DB + router)', () => {
  it('lowering the cap kills an older entra session on its next request', async () => {
    const { orgId, tenantId, session } = await setup({ entraEnabled: true, passwordMode: 'sso_only' });
    const older = await mint({ ...session, method: 'entra', entraTenantId: tenantId });
    const fresh = await mint({ ...session, method: 'entra', entraTenantId: tenantId });
    ageSession(older, 2 * HOUR_MS);
    ageSession(fresh, 30 * 60_000);

    // Default 12 h: both live.
    expect((await profile(older)).status).toBe(200);
    expect((await profile(fresh)).status).toBe(200);

    await setOrgPolicy(orgId, { ssoSessionMaxHours: 1 });

    await expectRefusedAndPurged(older);
    expect((await profile(fresh)).status).toBe(200);

    // Purged, not merely refused: raising the cap again does not revive it.
    await setOrgPolicy(orgId, { ssoSessionMaxHours: 12 });
    expect((await profile(older)).status).toBe(401);
  });

  it("entra session dies when the org's proven tenant changes", async () => {
    const { orgId, tenantId, session } = await setup({ entraEnabled: true });
    const pinned = await mint({ ...session, method: 'entra', entraTenantId: tenantId });
    expect((await profile(pinned)).status).toBe(200);

    // The org now holds a proof for ANOTHER tenant (a new proof sets proven_at,
    // so the clear-on-repoint trigger keeps it): Microsoft stays on, but the
    // session pinned to the old tenant is dead.
    const newTenant = randomUUID();
    await getTestDb().update(clientAiTenantMappings)
      .set({ entraTenantId: newTenant, provenAt: new Date(Date.now() + 1000) })
      .where(eq(clientAiTenantMappings.orgId, orgId));
    await expectRefusedAndPurged(pinned);

    // A session pinned to the new proven tenant is fine — it is the pin, not Microsoft, that refused.
    const repinned = await mint({ ...session, method: 'entra', entraTenantId: newTenant });
    expect((await profile(repinned)).status).toBe(200);

    // The proof is removed altogether (tenant link removed): Microsoft is masked off and the session dies.
    await getTestDb().delete(clientAiTenantMappings).where(eq(clientAiTenantMappings.orgId, orgId));
    await expectRefusedAndPurged(repinned);
  });

  it('entra session dies on the next request after entra is turned off', async () => {
    const { orgId, tenantId, session } = await setup({ entraEnabled: true });
    const token = await mint({ ...session, method: 'entra', entraTenantId: tenantId });
    expect((await profile(token)).status).toBe(200);

    await setOrgPolicy(orgId, { entraEnabled: false });
    await expectRefusedAndPurged(token);
  });

  it('an entra session never satisfies a password-only gate and vice versa', async () => {
    // Password-only org (Microsoft off), tenant proven: an entra session is refused.
    const pwOnly = await setup({ entraEnabled: false });
    const entraInPwOnly = await mint({ ...pwOnly.session, method: 'entra', entraTenantId: pwOnly.tenantId });
    const pwInPwOnly = await mint({ ...pwOnly.session, method: 'password' });
    await expectRefusedAndPurged(entraInPwOnly);
    expect((await profile(pwInPwOnly)).status).toBe(200);

    // sso_only org (Microsoft only): a password session is refused, an entra session admitted.
    const ssoOnly = await setup({ entraEnabled: true, passwordMode: 'sso_only' });
    const pwInSsoOnly = await mint({ ...ssoOnly.session, method: 'password' });
    const entraInSsoOnly = await mint({ ...ssoOnly.session, method: 'entra', entraTenantId: ssoOnly.tenantId });
    await expectRefusedAndPurged(pwInSsoOnly);
    expect((await profile(entraInSsoOnly)).status).toBe(200);
  });
});

/**
 * Review Focus 1 end to end (plan D7, spec §5.4): org A holds a proven tenant
 * T; a proof run in org B (another partner) proves T through the real proof
 * service. The displacement's epoch bump is the only thing that reaches A's
 * live add-in sessions (the add-in middleware reads no portal policy, inv. 9),
 * so this drives the real client-AI auth middleware against the session
 * payload the exchange writes (services/clientAiExchange.ts).
 */
describe('the tenant changes hands: org A sessions after org B proves its tenant (real proof service + middleware)', () => {
  const addin = (() => {
    const a = new Hono();
    a.use('*', clientAiAuthMiddleware);
    a.get('/protected', (c) => c.json({ id: c.get('clientAiAuth').clientUserId }));
    return a;
  })();
  const callAddin = (token: string) => addin.request('/protected', { headers: { Authorization: `Bearer ${token}` } });

  /** Exactly what the add-in exchange stores for a resolved user. */
  async function mintAddinSession(user: { id: string; orgId: string; authEpoch: number }): Promise<string> {
    const token = `client-ai-${randomUUID()}`;
    const redis = getTestRedis();
    await redis.setex(
      CLIENT_AI_REDIS_KEYS.session(token),
      CLIENT_AI_SESSION_TTL_SECONDS,
      JSON.stringify({ portalUserId: user.id, orgId: user.orgId, authEpoch: user.authEpoch, createdAt: new Date().toISOString() }),
    );
    await redis.sadd(CLIENT_AI_REDIS_KEYS.userSessions(user.id), token);
    return token;
  }

  /** An Entra account (identity row + the legacy entra_* fence columns), as the add-in JIT creates it. */
  async function entraAccount(orgId: string, tid: string, browserAccess: 'granted' | 'none') {
    const oid = randomUUID();
    const [user] = await getTestDb().insert(portalUsers).values({
      orgId, email: `rf1-${randomUUID()}@acme.example`, authMethod: 'entra', status: 'active', browserAccess,
      entraTenantId: tid, entraOid: oid,
    }).returning({ id: portalUsers.id, orgId: portalUsers.orgId, authEpoch: portalUsers.authEpoch });
    await getTestDb().insert(portalUserIdentities).values({
      orgId, portalUserId: user!.id, provider: 'entra', issuer: entraIssuer(tid), subject: oid, entraTenantId: tid, linkedVia: 'jit',
    });
    return user!;
  }

  const proofRun = (orgId: string, tenantId: string) => recordEntraTenantProof({
    orgId, tenantId, via: 'proof_run', evidence: { adminOid: randomUUID(), runId: randomUUID() }, provenByUserId: null,
  });

  it("A's add-in session with an identity in T gets 401 and is purged; an A add-in session with no identity in T stays 200", async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const tid = randomUUID();
    expect((await proofRun(orgA.id, tid)).displaced).toBeNull();
    await seedPolicy({ orgId: orgA.id, entraEnabled: true });

    // In T: an add-in user who also has the browser portal (an entra browser session too).
    const inTenant = await entraAccount(orgA.id, tid, 'granted');
    // Not in T: an add-in user whose identity is in another tenant (the bump is per tenant, not per org).
    const elsewhere = await entraAccount(orgA.id, randomUUID(), 'none');
    const inTenantAddin = await mintAddinSession(inTenant);
    const elsewhereAddin = await mintAddinSession(elsewhere);
    const inTenantBrowser = await mint({
      portalUserId: inTenant.id, orgId: orgA.id, authEpoch: inTenant.authEpoch, method: 'entra', entraTenantId: tid,
    });

    // Before: everything is live (the 401s below are caused by the displacement, nothing else).
    expect((await callAddin(inTenantAddin)).status).toBe(200);
    expect((await callAddin(elsewhereAddin)).status).toBe(200);
    expect((await profile(inTenantBrowser)).status).toBe(200);

    // Org B, another partner, proves T with a proof run: A's proven mapping is displaced.
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const { displaced } = await proofRun(orgB.id, tid);
    expect(displaced).toMatchObject({ orgId: orgA.id, partnerId: partnerA.id, wasProven: true, epochsBumped: 1 });

    // The add-in session of the identity in T: 401, and purged from the store and the per-user index.
    const refused = await callAddin(inTenantAddin);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual(INVALID);
    const redis = getTestRedis();
    expect(await redis.get(CLIENT_AI_REDIS_KEYS.session(inTenantAddin))).toBeNull();
    expect(await redis.sismember(CLIENT_AI_REDIS_KEYS.userSessions(inTenant.id), inTenantAddin)).toBe(0);
    // Durable: the epoch moved, so a replay of the old payload can never pass again.
    const [after] = await getTestDb().select({ authEpoch: portalUsers.authEpoch }).from(portalUsers).where(eq(portalUsers.id, inTenant.id));
    expect(after!.authEpoch).toBe(inTenant.authEpoch + 1);

    // The browser side of the same person dies too (A no longer has a proven tenant).
    await expectRefusedAndPurged(inTenantBrowser);

    // The A add-in user with no identity in T is untouched.
    const kept = await callAddin(elsewhereAddin);
    expect(kept.status).toBe(200);
    expect(await kept.json()).toEqual({ id: elsewhere.id });
  });
});
