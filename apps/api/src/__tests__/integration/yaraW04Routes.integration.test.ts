/**
 * YARA W04 routes end to end on real Postgres (#6263 W04, #6267): the IOC
 * import (`POST /security/yara/rule-sets/:id/ioc-import`) and the rule test
 * upload's tenancy (`POST /security/yara/rule-sets/:id/test`).
 *
 * Drives the real router (authMiddleware -> requireScope -> requirePermission
 * -> handler -> publishRuleSet) with minted tokens, so the gates run against
 * genuine memberships and the yara RLS policies. The pre-check runs in dev
 * lint-only mode (BREEZE_YARA_LINT_ONLY=1, NODE_ENV=test) because the CI
 * integration job has no breeze-yarac binary.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/yaraW04Routes.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The test route's runner is stubbed (the CI integration job has no
// breeze-yarac binary); admission and everything before it are real.
const matchSampleMock = vi.hoisted(() => vi.fn());
vi.mock('../../services/yaraSampleMatch', async () => {
  const actual = await vi.importActual<typeof import('../../services/yaraSampleMatch')>('../../services/yaraSampleMatch');
  return { ...actual, matchSample: matchSampleMock };
});
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { generateIocRules, YARA_BUILTIN_RULE_SET_ID, YARA_MAX_RULES_PER_SET } from '@breeze/shared';
import { securityRoutes } from '../../routes/security';
import { yaraRuleSets, yaraRules } from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const DEVICE_RW = [
  { resource: 'devices', action: 'read' },
  { resource: 'devices', action: 'write' },
];

const ENV_KEYS = ['BREEZE_YARA_LINT_ONLY', 'BREEZE_YARAC_PATH'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.BREEZE_YARA_LINT_ONLY = '1';
  process.env.BREEZE_YARAC_PATH = '/nonexistent/breeze-yarac';
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await (getTestDb() as any).delete(yaraRuleSets).where(eq(yaraRuleSets.id, YARA_BUILTIN_RULE_SET_ID));
});

type Actor = { token: string };

async function mint(
  user: { id: string; email: string },
  roleId: string,
  scope: { partnerId: string; orgId: string | null; scope: 'partner' | 'organization' },
): Promise<Actor> {
  return {
    token: await createAccessToken({
      sub: user.id, email: user.email, roleId, orgId: scope.orgId, partnerId: scope.partnerId,
      scope: scope.scope, mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    }),
  };
}

const app = new Hono();
app.route('/security', securityRoutes);

function call(actor: Actor, method: string, path: string, body?: unknown) {
  return app.request(`/security${path}`, {
    method,
    headers: { Authorization: `Bearer ${actor.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seed() {
  const u = randomUUID().slice(0, 8);
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });

  const orgRole = await createRole({ scope: 'organization', orgId: orgA.id, partnerId: partner.id });
  await grantRolePermissions(orgRole.id, DEVICE_RW);
  const orgUser = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `yara-w04-org-${u}@example.test` });
  await assignUserToOrganization(orgUser.id, orgA.id, orgRole.id);

  const orgBRole = await createRole({ scope: 'organization', orgId: orgB.id, partnerId: partner.id });
  await grantRolePermissions(orgBRole.id, DEVICE_RW);
  const orgBUser = await createUser({ partnerId: partner.id, orgId: orgB.id, email: `yara-w04-orgb-${u}@example.test` });
  await assignUserToOrganization(orgBUser.id, orgB.id, orgBRole.id);

  const pRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(pRole.id, DEVICE_RW);
  const partnerAdmin = await createUser({ partnerId: partner.id, email: `yara-w04-padmin-${u}@example.test` });
  await assignUserToPartner(partnerAdmin.id, partner.id, pRole.id, 'all');

  await (getTestDb() as any)
    .insert(yaraRuleSets)
    .values({ id: YARA_BUILTIN_RULE_SET_ID, name: 'Built-in pack', source: 'builtin', isBuiltin: true })
    .onConflictDoNothing();

  return {
    partner, orgA, orgB,
    org: await mint(orgUser, orgRole.id, { partnerId: partner.id, orgId: orgA.id, scope: 'organization' }),
    orgBUser: await mint(orgBUser, orgBRole.id, { partnerId: partner.id, orgId: orgB.id, scope: 'organization' }),
    padmin: await mint(partnerAdmin, pRole.id, { partnerId: partner.id, orgId: null, scope: 'partner' }),
  };
}

async function createSet(actor: Actor, body: Record<string, unknown>): Promise<string> {
  const res = await call(actor, 'POST', '/yara/rule-sets', body);
  expect(res.status).toBe(201);
  return (await res.json()).data.id as string;
}

async function rulesOf(setId: string) {
  return (getTestDb() as any).select().from(yaraRules).where(eq(yaraRules.ruleSetId, setId));
}

const IMPORT = {
  label: 'W04 integration advisory',
  iocs: [
    { kind: 'sha256', value: 'c'.repeat(64) },
    { kind: 'domain', value: 'evil[.]example.com' },
    { kind: 'string', value: 'w04-integration-marker' },
  ],
};

describe('POST /security/yara/rule-sets/:id/ioc-import (real Postgres)', () => {
  it('org user imports into their own set: 201, the generated rules are stored verbatim and published', async () => {
    const w = await seed();
    const setId = await createSet(w.org, { name: 'Org IOCs' });

    const res = await call(w.org, 'POST', `/yara/rule-sets/${setId}/ioc-import`, IMPORT);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.publish).toMatchObject({ published: true, version: 1, stale: false });

    const expected = generateIocRules({ label: IMPORT.label, iocs: IMPORT.iocs as any });
    expect(body.data.rules.map((r: { name: string }) => r.name)).toEqual(expected.map((r) => r.name));
    const stored = await rulesOf(setId);
    expect(stored).toHaveLength(expected.length);
    for (const gen of expected) {
      const row = stored.find((r: { name: string }) => r.name === gen.name);
      expect(row).toMatchObject({ source: gen.source, severity: 'high', tags: gen.tags, enabled: true });
    }

    const view = await call(w.org, 'GET', `/yara/rule-sets/${setId}`);
    expect((await view.json()).data.rules).toHaveLength(expected.length);
  });

  it('org user cannot import into a partner-wide set (403, nothing inserted)', async () => {
    const w = await seed();
    const pw = await createSet(w.padmin, { name: 'MSP baseline', ownerScope: 'partner' });
    const res = await call(w.org, 'POST', `/yara/rule-sets/${pw}/ioc-import`, IMPORT);
    expect(res.status).toBe(403);
    expect(await rulesOf(pw)).toHaveLength(0);
  });

  it("org A user gets 404 on org B's set", async () => {
    const w = await seed();
    const setB = await createSet(w.orgBUser, { name: 'org B IOCs' });
    const res = await call(w.org, 'POST', `/yara/rule-sets/${setB}/ioc-import`, IMPORT);
    expect(res.status).toBe(404);
    expect(await rulesOf(setB)).toHaveLength(0);
  });

  it('a second identical import is a 409 and leaves the rule count unchanged', async () => {
    const w = await seed();
    const setId = await createSet(w.org, { name: 'repeat' });
    expect((await call(w.org, 'POST', `/yara/rule-sets/${setId}/ioc-import`, IMPORT)).status).toBe(201);
    const before = (await rulesOf(setId)).length;

    const again = await call(w.org, 'POST', `/yara/rule-sets/${setId}/ioc-import`, IMPORT);
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('IOC_BATCH_ALREADY_IMPORTED');
    expect(await rulesOf(setId)).toHaveLength(before);
  });

  it('two concurrent imports into a set holding 498 rules: exactly one 201, one IOC_TOO_MANY_RULES, 500 rules', async () => {
    const w = await seed();
    const setId = await createSet(w.org, { name: 'cap' });
    const db = getTestDb() as any;
    await db.insert(yaraRules).values(
      Array.from({ length: YARA_MAX_RULES_PER_SET - 2 }, (_, i) => ({
        ruleSetId: setId, name: `seed_${i}`, source: `rule seed_${i} { condition: true }`,
      })),
    );

    // Hold the set row lock from outside so both imports are in flight at once.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => { locked = r; });
    const holder = db.transaction(async (tx: any) => {
      await tx.select({ id: yaraRuleSets.id }).from(yaraRuleSets).where(eq(yaraRuleSets.id, setId)).for('update');
      locked();
      await held;
    });
    await lockTaken;

    // Each batch generates exactly two rules (md5 + domain).
    const batch = (n: string) => ({
      label: `race ${n}`,
      iocs: [{ kind: 'md5', value: n.repeat(32) }, { kind: 'domain', value: `race-${n}.example.com` }],
    });
    let responses: Response[];
    try {
      const inflight = Promise.all([
        call(w.org, 'POST', `/yara/rule-sets/${setId}/ioc-import`, batch('a')),
        call(w.org, 'POST', `/yara/rule-sets/${setId}/ioc-import`, batch('b')),
      ]);
      const deadline = Date.now() + 15_000;
      for (;;) {
        const waiting = await db.execute(
          sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
        );
        const rows = (waiting.rows ?? waiting) as Array<{ n: number }>;
        if (Number(rows[0]?.n) >= 2) break;
        if (Date.now() > deadline) throw new Error('imports never blocked on the set lock');
        await new Promise((r) => setTimeout(r, 25));
      }
      release();
      responses = await inflight;
    } finally {
      release();
      await holder.catch(() => {});
    }

    expect(responses.map((r) => r.status).sort()).toEqual([201, 400]);
    const capped = responses.find((r) => r.status === 400)!;
    expect((await capped.json()).code).toBe('IOC_TOO_MANY_RULES');
    expect(await rulesOf(setId)).toHaveLength(YARA_MAX_RULES_PER_SET);
  });
});

// Mounted under /api/v1 so the route runs on its real self-managed DB-context
// path (SELF_MANAGED_DB_CONTEXT_ROUTES matches the full request path).
const v1 = new Hono();
v1.route('/api/v1/security', securityRoutes);

function upload(actor: Actor, setId: string, body: BodyInit) {
  return v1.request(`/api/v1/security/yara/rule-sets/${setId}/test?filename=sample.bin`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${actor.token}`, 'Content-Type': 'application/octet-stream' },
    body,
  });
}

describe('POST /security/yara/rule-sets/:id/test tenancy (real Postgres, runner stubbed)', () => {
  const ok = async (reservation: { release(): void }, input: { bundleJson: string }) => {
    reservation.release();
    expect(JSON.parse(input.bundleJson).rules.length).toBeGreaterThan(0);
    return { ok: true, matches: [], durationMs: 1 };
  };

  it("an org user may test the built-in set and their MSP's partner-wide set (200, not 404)", async () => {
    const w = await seed();
    const db = getTestDb() as any;
    await db.insert(yaraRules).values({
      ruleSetId: YARA_BUILTIN_RULE_SET_ID, name: `w04_builtin_${randomUUID().slice(0, 8)}`, source: 'rule placeholder { condition: false }',
    }).onConflictDoNothing();
    const pw = await createSet(w.padmin, { name: 'MSP baseline', ownerScope: 'partner' });
    expect((await call(w.padmin, 'POST', `/yara/rule-sets/${pw}/rules`, { name: 'pw_rule', source: 'rule pw_rule { condition: false }' })).status).toBe(201);

    matchSampleMock.mockReset();
    matchSampleMock.mockImplementation(ok);
    const builtin = await upload(w.org, YARA_BUILTIN_RULE_SET_ID, new TextEncoder().encode('hello'));
    expect(builtin.status).toBe(200);
    const partnerWide = await upload(w.org, pw, new TextEncoder().encode('hello'));
    expect(partnerWide.status).toBe(200);
    expect((await partnerWide.json()).data).toMatchObject({ testedVersion: 1, publishedVersion: 1, matches: [] });
    expect(matchSampleMock).toHaveBeenCalledTimes(2);
  });

  it("an org-B user gets 404 on org A's set, and the runner never runs", async () => {
    const w = await seed();
    const setA = await createSet(w.org, { name: 'org A IOCs' });
    expect((await call(w.org, 'POST', `/yara/rule-sets/${setA}/ioc-import`, IMPORT)).status).toBe(201);
    matchSampleMock.mockReset();
    const res = await upload(w.orgBUser, setA, new TextEncoder().encode('hello'));
    expect(res.status).toBe(404);
    expect(matchSampleMock).not.toHaveBeenCalled();
  });
});
