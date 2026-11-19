/**
 * Portal registration W2 (#11379), spec §6 invariant 8 / Review Focus 3:
 * portal password login never reveals that an address has more than one
 * account, and never signs a person in to an arbitrary org.
 *
 * Real Postgres as breeze_app (the login lookup runs under system scope).
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalLoginUniformFailure.integration.test.ts
 */
import './setup';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { portalUsers } from '../../db/schema';
import { portalRoutes } from '../../routes/portal';
import { portalRateLimitBuckets, portalSessions } from '../../routes/portal/helpers';
import { hashPassword } from '../../services/password';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const SAME = 'SamePortalPass1!';

function buildPortalApp(): Hono {
  const app = new Hono();
  app.route('/portal', portalRoutes);
  return app;
}

const login = (body: Record<string, unknown>) =>
  buildPortalApp().request('/portal/auth/login', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

async function seedAccount(orgId: string, email: string, password: string, over: Partial<typeof portalUsers.$inferInsert> = {}) {
  const [row] = await getTestDb().insert(portalUsers).values({
    orgId, email, passwordHash: await hashPassword(password), authMethod: 'password', status: 'active', browserAccess: 'granted', ...over,
  }).returning({ id: portalUsers.id });
  return row!.id;
}

let orgA: string;
let orgB: string;

beforeEach(async () => {
  portalSessions.clear();
  portalRateLimitBuckets.clear();
  const partner = await createPartner();
  orgA = (await createOrganization({ partnerId: partner.id })).id;
  orgB = (await createOrganization({ partnerId: partner.id })).id;
});

describe('portal login with an email in several organizations (W2)', () => {
  it('same password in two orgs → the generic 401, byte-identical to a wrong password, and no session', async () => {
    await seedAccount(orgA, 'shared@acme.example', SAME);
    await seedAccount(orgB, 'shared@acme.example', SAME);
    await seedAccount(orgA, 'solo@acme.example', 'SoloPortalPass1!');

    const dup = await login({ email: 'shared@acme.example', password: SAME });
    const bad = await login({ email: 'solo@acme.example', password: 'WrongPortalPass1!' });

    expect(dup.status).toBe(401);
    expect(bad.status).toBe(401);
    expect(await dup.text()).toBe(await bad.text());
    expect(portalSessions.size).toBe(0);
  });

  it('different passwords → signs in to the org whose password verified', async () => {
    await seedAccount(orgA, 'shared@acme.example', 'OrgAPortalPass1!');
    const inB = await seedAccount(orgB, 'shared@acme.example', 'OrgBPortalPass1!');

    const res = await login({ email: 'shared@acme.example', password: 'OrgBPortalPass1!' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.id).toBe(inB);
    expect([...portalSessions.values()].map((s) => s.orgId)).toEqual([orgB]);
  });

  it('orgId still selects the account when the same password is used in both orgs', async () => {
    await seedAccount(orgA, 'shared@acme.example', SAME);
    const inB = await seedAccount(orgB, 'shared@acme.example', SAME);
    const res = await login({ email: 'shared@acme.example', password: SAME, orgId: orgB });
    expect(res.status).toBe(200);
    expect((await res.json()).user.id).toBe(inB);
  });

  it('a password row with browser_access none cannot log in (generic 401)', async () => {
    await seedAccount(orgA, 'nobrowser@acme.example', SAME, { browserAccess: 'none' });
    const res = await login({ email: 'nobrowser@acme.example', password: SAME, orgId: orgA });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid email or password' });
  });

  it('an add-in (entra) row on the same address is never a password candidate', async () => {
    await seedAccount(orgA, 'mixed@acme.example', SAME);
    await getTestDb().insert(portalUsers).values({
      orgId: orgB, email: 'mixed@acme.example', passwordHash: await hashPassword(SAME), authMethod: 'entra',
      entraOid: `oid-${Date.now()}`, entraTenantId: `tid-${Date.now()}`, status: 'active', browserAccess: 'none',
    });
    const res = await login({ email: 'mixed@acme.example', password: SAME });
    expect(res.status).toBe(200);
    expect([...portalSessions.values()].map((s) => s.orgId)).toEqual([orgA]);
  });
});
