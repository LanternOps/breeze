import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildYaraBundleJson } from '@breeze/shared';

// ---- mock db: captures every update(...).set(...) by table -----------------

const state = vi.hoisted(() => ({
  set: null as Record<string, unknown> | null,
  rules: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
  inTx: true,
}));

vi.mock('../db', async () => {
  const schema = await import('../db/schema');
  const tableName = (t: unknown) => (t === schema.yaraRuleSets ? 'yara_rule_sets' : t === schema.yaraRules ? 'yara_rules' : 'other');
  const select = () => ({
    from: (table: unknown) => ({
      where: () => {
        const rows = tableName(table) === 'yara_rule_sets' ? (state.set ? [state.set] : []) : state.rules;
        const p = Promise.resolve(rows) as Promise<unknown[]> & {
          for: () => Promise<unknown[]>;
          orderBy: () => Promise<unknown[]>;
        };
        p.for = () => Promise.resolve(rows);
        p.orderBy = () => Promise.resolve(rows);
        return p;
      },
    }),
  });
  const update = (table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        state.updates.push({ table: tableName(table), values });
        return Promise.resolve([]);
      },
    }),
  });
  return {
    db: { select, update },
    assertInTransaction: (label: string) => {
      if (!state.inTx) throw new Error(`${label} must run inside withDbAccessContext`);
    },
  };
});

const precheckMock = vi.fn();
const versionMock = vi.fn();
vi.mock('./yaraPrecheck', () => ({
  precheckYaraBundle: (json: string) => precheckMock(json),
  yaracVersion: () => versionMock(),
}));

import { publishRuleSet, YaraRuleSetNotFoundError } from './yaraRuleSetPublisher';

const R = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, severity: 'high', source: `rule ${name} { condition: true }`, enabled: true, compileError: null, ...extra,
});

function seed() {
  state.set = { id: 'S', currentVersion: 3, publishedVersion: 3, autoQuarantine: false, isBuiltin: false };
  // The publisher selects enabled rules only; R3 (disabled) is not returned by
  // the enabled filter, which the 'disabled excluded' case pins via the JSON.
  state.rules = [R('R1', 'r_one'), R('R2', 'r_two', { compileError: 'compile: old' })];
  state.updates = [];
  state.inTx = true;
}

const setUpdate = () => state.updates.filter((u) => u.table === 'yara_rule_sets').at(-1)?.values;
const ruleUpdates = () => state.updates.filter((u) => u.table === 'yara_rules').map((u) => u.values);

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  seed();
  precheckMock.mockReset();
  versionMock.mockReset();
  versionMock.mockResolvedValue({ engine: 'yaraxwasm v1.1.0', policy: 1 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('publishRuleSet', () => {
  it('clean publish snapshots the canonical bundle at currentVersion + 1', async () => {
    precheckMock.mockResolvedValue({ ok: true });
    const res = await publishRuleSet('S');

    const expectedJson = buildYaraBundleJson({
      ruleSetId: 'S', version: 4, autoQuarantine: false,
      rules: [
        { id: 'R1', name: 'r_one', severity: 'high', source: 'rule r_one { condition: true }' },
        { id: 'R2', name: 'r_two', severity: 'high', source: 'rule r_two { condition: true }' },
      ],
    });
    expect(precheckMock).toHaveBeenCalledWith(expectedJson);
    const u = setUpdate()!;
    expect(u.currentVersion).toBe(4);
    expect(u.publishedVersion).toBe(4);
    expect(Buffer.isBuffer(u.publishedBundle)).toBe(true);
    expect((u.publishedBundle as Buffer).toString('utf8')).toBe(expectedJson);
    expect(u.publishedSha256).toBe(createHash('sha256').update(expectedJson, 'utf8').digest('hex'));
    expect(u.publishedEngine).toBe('yaraxwasm v1.1.0');
    expect(u.publishedPolicy).toBe(1);
    expect(u.stale).toBe(false);
    expect(u.ruleCount).toBe(2);
    // Only R2's stale error needed clearing; R1 was already null.
    expect(ruleUpdates()).toEqual([{ compileError: null, updatedAt: expect.any(Date) }]);
    expect(res).toEqual({ published: true, version: 4, currentVersion: 4, stale: false, errors: [] });
  });

  it('one failing rule: set goes stale on its last good version, the rule carries the error', async () => {
    precheckMock.mockResolvedValue({ ok: false, errors: [{ ruleId: 'R2', name: 'r_two', code: 'compile', message: 'x' }] });
    const res = await publishRuleSet('S');
    const u = setUpdate()!;
    expect(u).toMatchObject({ currentVersion: 4, stale: true, ruleCount: 2 });
    for (const key of ['publishedVersion', 'publishedBundle', 'publishedSha256', 'publishedAt', 'publishedEngine', 'publishedPolicy']) {
      expect(u).not.toHaveProperty(key);
    }
    expect(ruleUpdates()).toEqual([{ compileError: 'compile: x', updatedAt: expect.any(Date) }]);
    expect(res).toMatchObject({ published: false, version: 3, currentVersion: 4, stale: true });
    expect(res.errors).toEqual([{ ruleId: 'R2', name: 'r_two', code: 'compile', message: 'x' }]);
  });

  it('a bundle-level error (no rule owns it) still blocks publishing and is returned', async () => {
    precheckMock.mockResolvedValue({ ok: false, errors: [{ ruleId: '', name: '', code: 'cap_strings', message: 'too many strings' }] });
    const res = await publishRuleSet('S');
    expect(setUpdate()).toMatchObject({ stale: true });
    expect(setUpdate()).not.toHaveProperty('publishedVersion');
    expect(res.errors).toEqual([{ ruleId: null, name: '', code: 'cap_strings', message: 'too many strings' }]);
  });

  // The enabled filter is SQL (pinned against real Postgres in
  // yaraRuleSetRoutes.integration.test.ts); here we pin that exactly the
  // returned rows, and nothing else, reach the bundle.
  it('every selected rule, and only those, goes into the bundle', async () => {
    precheckMock.mockResolvedValue({ ok: true });
    await publishRuleSet('S');
    const json = precheckMock.mock.calls[0]![0] as string;
    expect(json).toContain('"R1"');
    expect(json).toContain('"R2"');
    expect(JSON.parse(json).rules).toHaveLength(2);
  });

  it('pre-check unavailable in production: refuse to publish, mark stale, log loudly', async () => {
    process.env.NODE_ENV = 'production';
    process.env.BREEZE_YARA_LINT_ONLY = '1'; // ignored in production
    precheckMock.mockResolvedValue({ ok: false, unavailable: 'ENOENT' });
    const res = await publishRuleSet('S');
    expect(setUpdate()).toMatchObject({ currentVersion: 4, stale: true });
    expect(setUpdate()).not.toHaveProperty('publishedVersion');
    expect(res).toMatchObject({ published: false, version: 3, stale: true, unavailable: 'ENOENT' });
    expect(console.error).toHaveBeenCalled();
  });

  it('pre-check unavailable outside production without the lint-only flag: refuse too', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.BREEZE_YARA_LINT_ONLY;
    precheckMock.mockResolvedValue({ ok: false, unavailable: 'ENOENT' });
    const res = await publishRuleSet('S');
    expect(res).toMatchObject({ published: false, stale: true });
  });

  it('lint-only in dev: publishes and records the engine as lint-only', async () => {
    process.env.NODE_ENV = 'test';
    process.env.BREEZE_YARA_LINT_ONLY = '1';
    precheckMock.mockResolvedValue({ ok: false, unavailable: 'ENOENT' });
    const res = await publishRuleSet('S');
    expect(setUpdate()).toMatchObject({ publishedVersion: 4, publishedEngine: 'lint-only', publishedPolicy: null, stale: false });
    expect(versionMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ published: true, version: 4 });
  });

  it('a set with no enabled rules is UNpublished (devices stop scanning with it), not published empty', async () => {
    state.rules = [];
    const res = await publishRuleSet('S');
    expect(precheckMock).not.toHaveBeenCalled();
    expect(setUpdate()).toMatchObject({
      currentVersion: 4, publishedVersion: 0, publishedBundle: null, publishedSha256: null,
      publishedAt: null, publishedEngine: null, publishedPolicy: null, stale: false, ruleCount: 0,
    });
    expect(res).toEqual({ published: false, version: 0, currentVersion: 4, stale: false, errors: [] });
  });

  it('pre-check unavailable: stored per-rule compile errors are left alone (nothing new is known)', async () => {
    precheckMock.mockResolvedValue({ ok: false, unavailable: 'timeout' });
    await publishRuleSet('S');
    expect(ruleUpdates()).toEqual([]);
  });

  it('bundle-level errors only: stored per-rule compile errors are left alone', async () => {
    precheckMock.mockResolvedValue({ ok: false, errors: [{ ruleId: '', name: '', code: 'cap_rules', message: 'too many' }] });
    await publishRuleSet('S');
    expect(ruleUpdates()).toEqual([]);
  });

  it('a successful pre-check whose version probe fails still publishes, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    precheckMock.mockResolvedValue({ ok: true });
    versionMock.mockResolvedValue(null);
    const res = await publishRuleSet('S');
    expect(res.published).toBe(true);
    expect(setUpdate()).toMatchObject({ publishedEngine: null, publishedPolicy: null });
    expect(warn).toHaveBeenCalled();
  });

  it('lint-only needs an explicit development/test NODE_ENV (unset NODE_ENV refuses)', async () => {
    delete process.env.NODE_ENV;
    process.env.BREEZE_YARA_LINT_ONLY = '1';
    precheckMock.mockResolvedValue({ ok: false, unavailable: 'ENOENT' });
    const res = await publishRuleSet('S');
    expect(res).toMatchObject({ published: false, stale: true });
  });

  describe('turning auto-quarantine OFF while the set cannot be published (fail-safe)', () => {
    const lastGood = (autoQuarantine: boolean) => buildYaraBundleJson({
      ruleSetId: 'S', version: 3, autoQuarantine,
      rules: [{ id: 'R1', name: 'r_one', severity: 'high', source: 'rule r_one { condition: true }' }],
    });

    it('republishes the LAST GOOD rules with autoQuarantine false at the new version; the set stays stale', async () => {
      state.set = { ...state.set!, autoQuarantine: false, publishedBundle: Buffer.from(lastGood(true)), publishedEngine: 'e1', publishedPolicy: 1 };
      precheckMock.mockResolvedValue({ ok: false, errors: [{ ruleId: 'R2', name: 'r_two', code: 'compile', message: 'x' }] });
      const res = await publishRuleSet('S');

      const expected = buildYaraBundleJson({
        ruleSetId: 'S', version: 4, autoQuarantine: false,
        rules: [{ id: 'R1', name: 'r_one', severity: 'high', source: 'rule r_one { condition: true }' }],
      });
      const u = setUpdate()!;
      expect((u.publishedBundle as Buffer).toString('utf8')).toBe(expected);
      expect(u).toMatchObject({
        currentVersion: 4, publishedVersion: 4, stale: true,
        publishedSha256: createHash('sha256').update(expected, 'utf8').digest('hex'),
      });
      // No new compile happened: the engine stamp of the last good publish stands.
      expect(u).not.toHaveProperty('publishedEngine');
      expect(u).not.toHaveProperty('publishedPolicy');
      expect(res).toMatchObject({ published: true, version: 4, stale: true, autoQuarantineOnly: true });
    });

    it('also applies when the pre-check is unavailable', async () => {
      process.env.NODE_ENV = 'production';
      state.set = { ...state.set!, autoQuarantine: false, publishedBundle: Buffer.from(lastGood(true)) };
      precheckMock.mockResolvedValue({ ok: false, unavailable: 'ENOENT' });
      const res = await publishRuleSet('S');
      expect(res).toMatchObject({ published: true, stale: true, autoQuarantineOnly: true, unavailable: 'ENOENT' });
    });

    it('does nothing extra when the last good bundle already has auto-quarantine off', async () => {
      state.set = { ...state.set!, autoQuarantine: false, publishedBundle: Buffer.from(lastGood(false)) };
      precheckMock.mockResolvedValue({ ok: false, errors: [{ ruleId: 'R2', name: 'r_two', code: 'compile', message: 'x' }] });
      const res = await publishRuleSet('S');
      expect(setUpdate()).not.toHaveProperty('publishedVersion');
      expect(res).toMatchObject({ published: false, version: 3 });
    });

    it('never turns auto-quarantine ON through this path', async () => {
      state.set = { ...state.set!, autoQuarantine: true, publishedBundle: Buffer.from(lastGood(false)) };
      precheckMock.mockResolvedValue({ ok: false, errors: [{ ruleId: 'R2', name: 'r_two', code: 'compile', message: 'x' }] });
      const res = await publishRuleSet('S');
      expect(setUpdate()).not.toHaveProperty('publishedVersion');
      expect(res.published).toBe(false);
    });
  });

  it('a missing (or RLS-invisible / not lockable) set throws NotFound', async () => {
    state.set = null;
    await expect(publishRuleSet('S')).rejects.toBeInstanceOf(YaraRuleSetNotFoundError);
    expect(precheckMock).not.toHaveBeenCalled();
  });

  it('refuses the built-in set (published only by the boot upsert)', async () => {
    state.set = { ...state.set!, isBuiltin: true };
    await expect(publishRuleSet('S')).rejects.toThrow(/built-in/i);
    expect(state.updates).toEqual([]);
  });

  it('must run inside a DB context transaction', async () => {
    state.inTx = false;
    await expect(publishRuleSet('S')).rejects.toThrow(/withDbAccessContext/);
  });
});
