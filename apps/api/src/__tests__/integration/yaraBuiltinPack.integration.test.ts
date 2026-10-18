/**
 * Built-in YARA pack boot upsert (#6263 W03b) against real Postgres as
 * breeze_app, with REAL Ed25519 signed-manifest verification (a throwaway
 * key as the trust root, BINARY_SOURCE=local staging).
 *
 * The pre-check runs for real too: BREEZE_YARAC_PATH points at a missing
 * binary, so `breeze-yarac validate` is genuinely unavailable — production
 * must refuse, dev/test publishes lint-only behind BREEZE_YARA_LINT_ONLY=1.
 * Set BREEZE_YARAC_TEST_PATH to a built breeze-yarac (and
 * BREEZE_YARA_PACK_TEST_PATH to a built pack) to also run the real compiler
 * over the real 500-rule pack.
 *
 * cleanupDatabase() TRUNCATEs organizations/partners CASCADE before every
 * test, which empties yara_rule_sets too — so each case starts from "no
 * built-in row" and stages its own history.
 */
import './setup';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildYaraBundleJson, YARA_BUILTIN_RULE_SET_ID } from '@breeze/shared';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { yaraRuleSets, yaraRules } from '../../db/schema';
import { syncBuiltinYaraPack } from '../../services/yaraBuiltinPack';
import { __resetYaracForTests } from '../../services/yaraPrecheck';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const orgCtx = (orgId: string, partnerId: string): DbAccessContext => ({
  scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: partnerId,
});
const partnerCtx = (partnerId: string, orgIds: string[]): DbAccessContext => ({
  scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null, currentPartnerId: partnerId,
});
const as = <T>(ctx: DbAccessContext, fn: () => Promise<T>) => withDbAccessContext(ctx, fn);

const ASSET = 'breeze-yara-builtin.json';
const rule = (n: number, severity: 'high' | 'critical' = 'high') => ({
  id: `0000000${n}-0000-5000-8000-00000000000${n}`,
  name: `builtin_rule_${n}`,
  severity,
  source: `rule builtin_rule_${n} { strings: $a = "breeze_builtin_${n}" condition: $a }`,
});
const pack = (version: number, ruleNums: number[]) =>
  Buffer.from(buildYaraBundleJson({ ruleSetId: YARA_BUILTIN_RULE_SET_ID, version, autoQuarantine: true, rules: ruleNums.map((n) => rule(n)) }));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let tmp: string;
let key: KeyObject;
const saved = { ...process.env };

function stage(bytes: Buffer): void {
  mkdirSync(join(tmp, 'agent'), { recursive: true });
  writeFileSync(join(tmp, 'agent', ASSET), bytes);
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 1, repository: 'LanternOps/breeze', release: 'v9.9.9',
    assets: [{ name: ASSET, sha256: sha(bytes), size: bytes.length, platformTrust: 'release-workflow-produced', edition: 'self-host' }],
  }));
  writeFileSync(join(tmp, 'release-artifact-manifest.json'), manifest);
  writeFileSync(join(tmp, 'release-artifact-manifest.json.ed25519'), sign(null, manifest, key).toString('base64'));
}

async function builtinRow() {
  const [row] = await as(SYSTEM_CTX, () => db.select().from(yaraRuleSets).where(eq(yaraRuleSets.id, YARA_BUILTIN_RULE_SET_ID)));
  return row;
}
async function builtinRules() {
  return as(SYSTEM_CTX, () => db.select().from(yaraRules).where(eq(yaraRules.ruleSetId, YARA_BUILTIN_RULE_SET_ID)));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'yara-builtin-int-'));
  const kp = generateKeyPairSync('ed25519');
  key = kp.privateKey;
  const der = kp.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = der.subarray(der.length - 32).toString('base64');
  process.env.BINARY_SOURCE = 'local';
  process.env.AGENT_BINARY_DIR = join(tmp, 'agent');
  delete process.env.HELPER_BINARY_DIR;
  delete process.env.BINARY_EDITION;
  process.env.NODE_ENV = 'test';
  process.env.BREEZE_YARA_LINT_ONLY = '1';
  process.env.BREEZE_YARAC_PATH = join(tmp, 'no-such-breeze-yarac');
  __resetYaracForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  process.env = { ...saved };
  vi.restoreAllMocks();
});

afterAll(async () => {
  await as(SYSTEM_CTX, () => db.delete(yaraRuleSets).where(eq(yaraRuleSets.id, YARA_BUILTIN_RULE_SET_ID)));
});

describe('syncBuiltinYaraPack (real Postgres, real signed manifest)', () => {
  it('first boot publishes the shipped bytes; a second boot is unchanged and writes nothing', async () => {
    const v3 = pack(3, [1, 2]);
    stage(v3);
    await expect(syncBuiltinYaraPack()).resolves.toBe('updated');

    const row = await builtinRow();
    expect(row).toMatchObject({
      isBuiltin: true, source: 'builtin', orgId: null, partnerId: null, enabled: true, autoQuarantine: true,
      currentVersion: 3, publishedVersion: 3, publishedSha256: sha(v3), stale: false, ruleCount: 2, publishedEngine: 'lint-only',
    });
    expect(Buffer.from(row!.publishedBundle!).equals(v3)).toBe(true);
    const rules = await builtinRules();
    expect(rules.map((r) => r.id).sort()).toEqual([rule(1).id, rule(2).id]);
    for (const r of rules) expect(r).toMatchObject({ isBuiltin: true, orgId: null, partnerId: null, compileError: null, enabled: true });

    await expect(syncBuiltinYaraPack()).resolves.toBe('unchanged');
    const again = await builtinRow();
    expect(again!.updatedAt.getTime()).toBe(row!.updatedAt.getTime());
  });

  it('a newer pack replaces the set and removes rules no longer shipped; an older one never clobbers it', async () => {
    stage(pack(3, [1, 2]));
    await expect(syncBuiltinYaraPack()).resolves.toBe('updated');

    const v4 = pack(4, [1, 3]);
    stage(v4);
    await expect(syncBuiltinYaraPack()).resolves.toBe('updated');
    expect((await builtinRow())!.publishedVersion).toBe(4);
    expect((await builtinRules()).map((r) => r.id).sort()).toEqual([rule(1).id, rule(3).id]);

    stage(pack(2, [9]));
    await expect(syncBuiltinYaraPack()).resolves.toBe('unchanged');
    const row = await builtinRow();
    expect(row!.publishedVersion).toBe(4);
    expect(Buffer.from(row!.publishedBundle!).equals(v4)).toBe(true);
    expect((await builtinRules()).map((r) => r.id).sort()).toEqual([rule(1).id, rule(3).id]);
  });

  it('a tampered pack is skipped and the published set is untouched', async () => {
    const v3 = pack(3, [1]);
    stage(v3);
    await expect(syncBuiltinYaraPack()).resolves.toBe('updated');

    stage(pack(5, [1, 2]));
    writeFileSync(join(tmp, 'agent', ASSET), pack(5, [1, 2, 3])); // bytes no longer match the signed entry
    await expect(syncBuiltinYaraPack()).resolves.toBe('skipped');
    const row = await builtinRow();
    expect(row!.publishedVersion).toBe(3);
    expect(Buffer.from(row!.publishedBundle!).equals(v3)).toBe(true);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/does not verify/));
  });

  it('production with the pre-check unavailable refuses, even with BREEZE_YARA_LINT_ONLY=1', async () => {
    const v3 = pack(3, [1]);
    stage(v3);
    await expect(syncBuiltinYaraPack()).resolves.toBe('updated');

    process.env.NODE_ENV = 'production';
    stage(pack(4, [1, 2]));
    await expect(syncBuiltinYaraPack()).resolves.toBe('skipped');
    expect((await builtinRow())!.publishedVersion).toBe(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('pre-check unavailable'), expect.anything());
  });

  it('called from inside a request context it still writes as system, never through the caller\'s transaction', async () => {
    const partnerId = (await createPartner()).id;
    const orgId = (await createOrganization({ partnerId })).id;
    stage(pack(3, [1, 2]));
    const outcome = await as(orgCtx(orgId, partnerId), () => syncBuiltinYaraPack());
    expect(outcome).toBe('updated');
    expect((await builtinRow())!.publishedVersion).toBe(3);
  });

  it('two replicas booting at once: exactly one applies', async () => {
    stage(pack(3, [1, 2]));
    const outcomes = await Promise.all([syncBuiltinYaraPack(), syncBuiltinYaraPack()]);
    expect(outcomes.sort()).toEqual(['unchanged', 'updated']);
    expect((await builtinRules()).length).toBe(2);
  });

  it('org and partner users can read the built-in set and its rules (built-in SELECT policy) but never write them', async () => {
    const partnerId = (await createPartner()).id;
    const orgId = (await createOrganization({ partnerId })).id;
    stage(pack(3, [1, 2]));
    await expect(syncBuiltinYaraPack()).resolves.toBe('updated');

    for (const ctx of [orgCtx(orgId, partnerId), partnerCtx(partnerId, [orgId])]) {
      const sets = await as(ctx, () => db.select().from(yaraRuleSets).where(eq(yaraRuleSets.id, YARA_BUILTIN_RULE_SET_ID)));
      expect(sets).toHaveLength(1);
      expect(Buffer.from(sets[0]!.publishedBundle!).length).toBeGreaterThan(0);
      const rules = await as(ctx, () => db.select().from(yaraRules).where(eq(yaraRules.ruleSetId, YARA_BUILTIN_RULE_SET_ID)));
      expect(rules).toHaveLength(2);
      const updated = await as(ctx, () =>
        db.update(yaraRuleSets).set({ autoQuarantine: false }).where(eq(yaraRuleSets.id, YARA_BUILTIN_RULE_SET_ID)).returning({ id: yaraRuleSets.id }),
      );
      expect(updated).toHaveLength(0);
      const deleted = await as(ctx, () => db.delete(yaraRules).where(eq(yaraRules.ruleSetId, YARA_BUILTIN_RULE_SET_ID)).returning({ id: yaraRules.id }));
      expect(deleted).toHaveLength(0);
    }
    expect((await builtinRow())!.autoQuarantine).toBe(true);
    expect((await builtinRules()).length).toBe(2);
  });

  const realYarac = process.env.BREEZE_YARAC_TEST_PATH;
  const realPack = process.env.BREEZE_YARA_PACK_TEST_PATH;
  it.runIf(Boolean(realYarac && realPack && existsSync(realYarac) && existsSync(realPack)))(
    'real breeze-yarac over the real built pack: production publishes it with the engine stamp',
    async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.BREEZE_YARA_LINT_ONLY;
      process.env.BREEZE_YARAC_PATH = realYarac!;
      __resetYaracForTests();
      const bytes = readFileSync(realPack!);
      stage(bytes);
      await expect(syncBuiltinYaraPack()).resolves.toBe('updated');
      const row = await builtinRow();
      expect(row!.publishedEngine).toMatch(/^v\d/);
      expect(row!.publishedPolicy).toBe(1);
      expect(row!.ruleCount).toBe((JSON.parse(bytes.toString('utf8')) as { rules: unknown[] }).rules.length);
      expect(Buffer.from(row!.publishedBundle!).equals(bytes)).toBe(true);
    },
    240_000,
  );
});
