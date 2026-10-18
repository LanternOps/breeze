/**
 * /security/yara routes end to end on real Postgres (#6263 W03a).
 *
 * Drives the real router (authMiddleware -> requireScope -> requirePermission
 * -> handler -> publishRuleSet) with minted tokens, so visibility and write
 * gates are proven against genuine memberships and the yara RLS policies, not
 * mocks. The pre-check runs in dev lint-only mode (BREEZE_YARA_LINT_ONLY=1,
 * NODE_ENV=test) because the CI integration job has no breeze-yarac binary;
 * the compile-error / stale / unavailable branches are pinned by
 * yaraRuleSetPublisher.test.ts and yaraPrecheck.test.ts.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/yaraRuleSetRoutes.integration.test.ts
 */
import './setup';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { buildYaraBundleJson, YARA_BUILTIN_RULE_SET_ID } from '@breeze/shared';
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
  const otherPartner = await createPartner();
  const otherOrg = await createOrganization({ partnerId: otherPartner.id });

  const orgRole = await createRole({ scope: 'organization', orgId: orgA.id, partnerId: partner.id });
  await grantRolePermissions(orgRole.id, DEVICE_RW);
  const orgUser = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `yara-org-${u}@example.test` });
  await assignUserToOrganization(orgUser.id, orgA.id, orgRole.id);

  const pRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(pRole.id, DEVICE_RW);
  const partnerAdmin = await createUser({ partnerId: partner.id, email: `yara-padmin-${u}@example.test` });
  await assignUserToPartner(partnerAdmin.id, partner.id, pRole.id, 'all');
  const partnerLimited = await createUser({ partnerId: partner.id, email: `yara-plim-${u}@example.test` });
  await assignUserToPartner(partnerLimited.id, partner.id, pRole.id, 'selected');

  await (getTestDb() as any)
    .insert(yaraRuleSets)
    .values({ id: YARA_BUILTIN_RULE_SET_ID, name: 'Built-in pack', source: 'builtin', isBuiltin: true })
    .onConflictDoNothing();
  const [otherSet] = await (getTestDb() as any)
    .insert(yaraRuleSets).values({ orgId: otherOrg.id, name: 'foreign' }).returning({ id: yaraRuleSets.id });

  return {
    partner, orgA, orgB, otherSetId: otherSet.id as string,
    org: await mint(orgUser, orgRole.id, { partnerId: partner.id, orgId: orgA.id, scope: 'organization' }),
    padmin: await mint(partnerAdmin, pRole.id, { partnerId: partner.id, orgId: null, scope: 'partner' }),
    plimited: await mint(partnerLimited, pRole.id, { partnerId: partner.id, orgId: null, scope: 'partner' }),
  };
}

async function setRow(id: string) {
  const [row] = await (getTestDb() as any).select().from(yaraRuleSets).where(eq(yaraRuleSets.id, id));
  return row;
}

describe('/security/yara routes (real Postgres)', () => {
  it('org user: create an org set, add a rule -> published v1 with the canonical bundle', async () => {
    const w = await seed();
    const created = await call(w.org, 'POST', '/yara/rule-sets', { name: 'Org IOCs' });
    expect(created.status).toBe(201);
    const set = (await created.json()).data;
    expect(set).toMatchObject({ orgId: w.orgA.id, partnerId: null, publishedVersion: 0, currentVersion: 0 });

    const ruleRes = await call(w.org, 'POST', `/yara/rule-sets/${set.id}/rules`, {
      name: 'evil_marker', source: 'rule evil_marker { strings: $a = "x" condition: $a }', severity: 'critical',
    });
    expect(ruleRes.status).toBe(201);
    const body = await ruleRes.json();
    expect(body.publish).toMatchObject({ published: true, version: 1, stale: false });

    const row = await setRow(set.id);
    const expected = buildYaraBundleJson({
      ruleSetId: set.id, version: 1, autoQuarantine: false,
      rules: [{ id: body.data.id, name: 'evil_marker', severity: 'critical', source: 'rule evil_marker { strings: $a = "x" condition: $a }' }],
    });
    expect(Buffer.from(row.publishedBundle).toString('utf8')).toBe(expected);
    expect(row.publishedSha256).toBe(createHash('sha256').update(expected).digest('hex'));
    expect(row.publishedEngine).toBe('lint-only');
  });

  it('only ENABLED rules are published (SQL filter, real Postgres)', async () => {
    const w = await seed();
    const set = (await (await call(w.org, 'POST', '/yara/rule-sets', { name: 'mixed' })).json()).data;
    await call(w.org, 'POST', `/yara/rule-sets/${set.id}/rules`, { name: 'on_rule', source: 'rule on_rule { condition: true }' });
    const off = await call(w.org, 'POST', `/yara/rule-sets/${set.id}/rules`, { name: 'off_rule', source: 'rule off_rule { condition: true }', enabled: false });
    expect((await off.json()).publish.version).toBe(2);
    const bundle = JSON.parse(Buffer.from((await setRow(set.id)).publishedBundle).toString('utf8'));
    expect(bundle.rules.map((r: { name: string }) => r.name)).toEqual(['on_rule']);
    expect((await setRow(set.id)).ruleCount).toBe(1);
  });

  it('org user lists own-org, its partner\'s partner-wide, and built-in sets — never a sibling org\'s or another partner\'s', async () => {
    const w = await seed();
    const pw = (await (await call(w.padmin, 'POST', '/yara/rule-sets', { name: 'MSP baseline', ownerScope: 'partner' })).json()).data;
    const sibling = (await (await call(w.padmin, 'POST', '/yara/rule-sets', { name: 'sibling', orgId: w.orgB.id })).json()).data;
    const own = (await (await call(w.org, 'POST', '/yara/rule-sets', { name: 'own' })).json()).data;

    const res = await call(w.org, 'GET', '/yara/rule-sets');
    expect(res.status).toBe(200);
    const ids = new Set((await res.json()).data.map((s: { id: string }) => s.id));
    expect(ids).toEqual(new Set([own.id, pw.id, YARA_BUILTIN_RULE_SET_ID]));
    expect(ids.has(sibling.id)).toBe(false);
    expect(ids.has(w.otherSetId)).toBe(false);

    expect((await call(w.org, 'GET', `/yara/rule-sets/${pw.id}`)).status).toBe(200);
    expect((await call(w.org, 'GET', `/yara/rule-sets/${w.otherSetId}`)).status).toBe(404);
  });

  it('org user cannot create, edit or add rules to a partner-wide set', async () => {
    const w = await seed();
    expect((await call(w.org, 'POST', '/yara/rule-sets', { name: 'x', ownerScope: 'partner' })).status).toBe(403);
    const pw = (await (await call(w.padmin, 'POST', '/yara/rule-sets', { name: 'MSP', ownerScope: 'partner' })).json()).data;
    expect((await call(w.org, 'PATCH', `/yara/rule-sets/${pw.id}`, { name: 'hijack' })).status).toBe(403);
    expect((await call(w.org, 'POST', `/yara/rule-sets/${pw.id}/rules`, { name: 'r', source: 'rule r { condition: true }' })).status).toBe(403);
    expect((await call(w.org, 'DELETE', `/yara/rule-sets/${pw.id}`)).status).toBe(403);
    expect((await setRow(pw.id)).name).toBe('MSP');
  });

  it('a partner user without full org access cannot create or edit a partner-wide set', async () => {
    const w = await seed();
    expect((await call(w.plimited, 'POST', '/yara/rule-sets', { name: 'x', ownerScope: 'partner' })).status).toBe(403);
    const pw = (await (await call(w.padmin, 'POST', '/yara/rule-sets', { name: 'MSP', ownerScope: 'partner' })).json()).data;
    expect((await call(w.plimited, 'PATCH', `/yara/rule-sets/${pw.id}`, { name: 'hijack' })).status).toBe(403);
  });

  it('the built-in set is read-only for every caller', async () => {
    const w = await seed();
    for (const actor of [w.org, w.padmin]) {
      expect((await call(actor, 'PATCH', `/yara/rule-sets/${YARA_BUILTIN_RULE_SET_ID}`, { enabled: false })).status).toBe(403);
      expect((await call(actor, 'DELETE', `/yara/rule-sets/${YARA_BUILTIN_RULE_SET_ID}`)).status).toBe(403);
      expect((await call(actor, 'POST', `/yara/rule-sets/${YARA_BUILTIN_RULE_SET_ID}/rules`, { name: 'r', source: 'rule r { condition: true }' })).status).toBe(403);
    }
    expect((await setRow(YARA_BUILTIN_RULE_SET_ID)).enabled).toBe(true);
  });

  it('PATCH ignores ownerScope/orgId: a set never changes owner', async () => {
    const w = await seed();
    const set = (await (await call(w.padmin, 'POST', '/yara/rule-sets', { name: 'org set', orgId: w.orgA.id })).json()).data;
    const res = await call(w.padmin, 'PATCH', `/yara/rule-sets/${set.id}`, { ownerScope: 'partner', orgId: w.orgB.id, name: 'renamed' });
    expect(res.status).toBe(200);
    const row = await setRow(set.id);
    expect(row).toMatchObject({ orgId: w.orgA.id, partnerId: null, name: 'renamed' });
  });

  it('duplicate rule name -> 409 without poisoning the request transaction', async () => {
    const w = await seed();
    const set = (await (await call(w.org, 'POST', '/yara/rule-sets', { name: 'dups' })).json()).data;
    await call(w.org, 'POST', `/yara/rule-sets/${set.id}/rules`, { name: 'same', source: 'rule same { condition: true }' });
    const dup = await call(w.org, 'POST', `/yara/rule-sets/${set.id}/rules`, { name: 'same', source: 'rule same { condition: false }' });
    expect(dup.status).toBe(409);
    expect((await setRow(set.id)).publishedVersion).toBe(1);
  });

  it('rule name / size validation is a 400 (mirrors the DB CHECKs)', async () => {
    const w = await seed();
    const set = (await (await call(w.org, 'POST', '/yara/rule-sets', { name: 'v' })).json()).data;
    expect((await call(w.org, 'POST', `/yara/rule-sets/${set.id}/rules`, { name: '9bad', source: 'x' })).status).toBe(400);
    expect((await call(w.org, 'POST', `/yara/rule-sets/${set.id}/rules`, { name: 'big', source: 'a'.repeat(65 * 1024) })).status).toBe(400);
  });

  it('rule edit republishes; deleting the last rule UNpublishes the set (no zero-rule YARA scans)', async () => {
    const w = await seed();
    const set = (await (await call(w.padmin, 'POST', '/yara/rule-sets', { name: 'p', orgId: w.orgA.id })).json()).data;
    const rule = (await (await call(w.padmin, 'POST', `/yara/rule-sets/${set.id}/rules`, { name: 'r1', source: 'rule r1 { condition: true }' })).json()).data;
    const edited = await call(w.padmin, 'PATCH', `/yara/rules/${rule.id}`, { severity: 'low' });
    expect((await edited.json()).publish.version).toBe(2);
    // padmin's role lacks devices:execute: turning auto-quarantine ON is refused...
    expect((await call(w.padmin, 'PATCH', `/yara/rule-sets/${set.id}`, { autoQuarantine: true })).status).toBe(403);
    const del = await call(w.padmin, 'DELETE', `/yara/rules/${rule.id}`);
    expect((await del.json()).publish).toMatchObject({ published: false, version: 0, currentVersion: 3, stale: false });
    expect(await setRow(set.id)).toMatchObject({ publishedVersion: 0, publishedBundle: null, publishedSha256: null, currentVersion: 3 });
  });

  it('deleting a set removes its rules', async () => {
    const w = await seed();
    const set = (await (await call(w.org, 'POST', '/yara/rule-sets', { name: 'gone' })).json()).data;
    await call(w.org, 'POST', `/yara/rule-sets/${set.id}/rules`, { name: 'r1', source: 'rule r1 { condition: true }' });
    expect((await call(w.org, 'DELETE', `/yara/rule-sets/${set.id}`)).status).toBe(200);
    const rules = await (getTestDb() as any).select().from(yaraRules).where(eq(yaraRules.ruleSetId, set.id));
    expect(rules).toEqual([]);
  });
});

/**
 * The compile-error / stale / fail-safe branches against real rows. CI has no
 * breeze-yarac binary, so a stand-in honours the exact C5 CLI contract
 * (`validate` on stdin -> {"ok","errors"} with exit 0/1; `version`): any rule
 * whose source mentions `undefined_ident` fails to compile.
 */
describe('/security/yara publishing against a C5-contract pre-check (real Postgres)', () => {
  const FAKE_YARAC = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'version') { process.stdout.write(JSON.stringify({ engine: 'fake-yarac', policy: 1, format: 1 }) + '\\n'); process.exit(0); }
let buf = '';
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  const b = JSON.parse(buf);
  const errors = b.rules.filter((r) => r.source.includes('undefined_ident'))
    .map((r) => ({ ruleId: r.id, name: r.name, code: 'compile', message: 'unknown identifier', line: 1 }));
  process.stdout.write(JSON.stringify({ ok: errors.length === 0, errors }) + '\\n');
  process.exit(errors.length ? 1 : 0);
});
`;
  let prior: { lint?: string; path?: string };

  beforeAll(() => {
    prior = { lint: process.env.BREEZE_YARA_LINT_ONLY, path: process.env.BREEZE_YARAC_PATH };
    const dir = mkdtempSync(join(tmpdir(), 'fake-yarac-'));
    const bin = join(dir, 'breeze-yarac');
    writeFileSync(bin, FAKE_YARAC);
    chmodSync(bin, 0o755);
    delete process.env.BREEZE_YARA_LINT_ONLY;
    process.env.BREEZE_YARAC_PATH = bin;
  });

  afterAll(() => {
    if (prior.lint === undefined) delete process.env.BREEZE_YARA_LINT_ONLY; else process.env.BREEZE_YARA_LINT_ONLY = prior.lint;
    if (prior.path === undefined) delete process.env.BREEZE_YARAC_PATH; else process.env.BREEZE_YARAC_PATH = prior.path;
  });

  it('a breaking edit leaves the last good bundle published, marks the set stale and the rule errored; fixing it republishes', async () => {
    const w = await seed();
    const set = (await (await call(w.org, 'POST', '/yara/rule-sets', { name: 'ci' })).json()).data;
    const good = (await (await call(w.org, 'POST', `/yara/rule-sets/${set.id}/rules`, { name: 'good_rule', source: 'rule good_rule { condition: true }' })).json());
    expect(good.publish).toMatchObject({ published: true, version: 1, stale: false });
    const v1 = await setRow(set.id);
    expect(v1.publishedEngine).toBe('fake-yarac');

    const broke = await call(w.org, 'PATCH', `/yara/rules/${good.data.id}`, { source: 'rule good_rule { condition: undefined_ident }' });
    expect(broke.status).toBe(200);
    const body = await broke.json();
    expect(body.publish).toMatchObject({ published: false, stale: true, version: 1, currentVersion: 2 });
    expect(body.publish.errors[0]).toMatchObject({ ruleId: good.data.id, code: 'compile' });

    const after = await setRow(set.id);
    expect(after).toMatchObject({ stale: true, currentVersion: 2, publishedVersion: 1, publishedSha256: v1.publishedSha256 });
    expect(Buffer.from(after.publishedBundle).equals(Buffer.from(v1.publishedBundle))).toBe(true);
    const [rule] = await (getTestDb() as any).select().from(yaraRules).where(eq(yaraRules.id, good.data.id));
    expect(rule.compileError).toMatch(/^compile: unknown identifier/);

    const fixed = await call(w.org, 'PATCH', `/yara/rules/${good.data.id}`, { source: 'rule good_rule { condition: false }' });
    expect((await fixed.json()).publish).toMatchObject({ published: true, version: 3, stale: false });
    const [ruleAfterFix] = await (getTestDb() as any).select().from(yaraRules).where(eq(yaraRules.id, good.data.id));
    expect(ruleAfterFix.compileError).toBeNull();
    expect((await setRow(set.id)).stale).toBe(false);
  });

  it('turning auto-quarantine OFF while a broken rule blocks publishing still reaches devices', async () => {
    const w = await seed();
    // Seed the set with auto-quarantine ON directly (the org role has no devices:execute).
    const [row] = await (getTestDb() as any).insert(yaraRuleSets)
      .values({ orgId: w.orgA.id, name: 'aq', autoQuarantine: true }).returning({ id: yaraRuleSets.id });
    const setId = row.id as string;
    await call(w.org, 'POST', `/yara/rule-sets/${setId}/rules`, { name: 'good_rule', source: 'rule good_rule { condition: true }' });
    expect(JSON.parse(Buffer.from((await setRow(setId)).publishedBundle).toString('utf8')).autoQuarantine).toBe(true);
    const brokenRes = await call(w.org, 'POST', `/yara/rule-sets/${setId}/rules`, { name: 'bad_rule', source: 'rule bad_rule { condition: undefined_ident }' });
    expect((await brokenRes.json()).publish).toMatchObject({ published: false, stale: true });

    const off = await call(w.org, 'PATCH', `/yara/rule-sets/${setId}`, { autoQuarantine: false });
    expect(off.status).toBe(200);
    expect((await off.json()).publish).toMatchObject({ published: true, autoQuarantineOnly: true, stale: true });

    const live = await setRow(setId);
    const bundle = JSON.parse(Buffer.from(live.publishedBundle).toString('utf8'));
    expect(bundle.autoQuarantine).toBe(false);
    expect(bundle.version).toBe(live.publishedVersion);
    // Still the last GOOD rules: the broken one is not shipped.
    expect(bundle.rules.map((r: { name: string }) => r.name)).toEqual(['good_rule']);
    expect(live.publishedSha256).toBe(createHash('sha256').update(Buffer.from(live.publishedBundle)).digest('hex'));
  });
});
