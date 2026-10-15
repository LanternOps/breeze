import { beforeEach, describe, expect, it, vi } from 'vitest';

// `system_protection` (#4609 W03) is inline-only. These cases pin the
// SERVICE-level backstop — the path the AI manage_policy_feature_link tool
// takes, which bypasses the HTTP route's validation — so a malformed or
// AI-guessed key is refused rather than persisted, and what IS stored is the
// parsed, default-filled object.
const m = vi.hoisted(() => ({
  rows: [] as unknown[][],
  inserted: [] as any[],
  updated: [] as any[],
}));

vi.mock('../db', () => {
  const tx: any = {};
  function result(rows: unknown[]) {
    const c: any = { then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no) };
    for (const key of ['from', 'where', 'limit', 'orderBy', 'returning', 'for', 'innerJoin', 'onConflictDoNothing']) c[key] = () => c;
    return c;
  }
  tx.select = () => result(m.rows.shift() ?? []);
  tx.transaction = (fn: any) => fn(tx);
  tx.update = () => ({
    set: (value: unknown) => {
      m.updated.push(value);
      return result([{ id: '11111111-1111-4111-8111-111111111111', featureType: 'system_protection' }]);
    },
  });
  tx.delete = () => ({ where: () => result([]) });
  tx.insert = () => ({
    values: (value: any) => {
      m.inserted.push(value);
      return result([{ id: '11111111-1111-4111-8111-111111111111', ...value }]);
    },
  });
  return {
    db: tx,
    runOutsideDbContext: (f: any) => f(),
    withSystemDbAccessContext: (f: any) => f(),
    withDbAccessContext: (_c: any, f: any) => f(),
  };
});

import { addFeatureLink, updateFeatureLink, validateFeaturePolicyExists } from './configurationPolicy';

const id = '11111111-1111-4111-8111-111111111111';
const DEFAULTS = { beforePatching: true, beforeScripts: false, beforeSoftwareInstall: false, labelPrefix: 'Breeze' };
const link = { id, configPolicyId: id, featureType: 'system_protection', featurePolicyId: null, inlineSettings: DEFAULTS };

beforeEach(() => {
  m.rows = [];
  m.inserted = [];
  m.updated = [];
});

describe('system_protection feature links (service backstop)', () => {
  it('addFeatureLink stores the parsed, default-filled settings', async () => {
    await addFeatureLink(id, 'system_protection', null, { beforeScripts: true });
    expect(m.inserted).toHaveLength(1);
    expect(m.inserted[0].inlineSettings).toEqual({ ...DEFAULTS, beforeScripts: true });
  });

  it('addFeatureLink refuses an unknown key without writing', async () => {
    await expect(
      addFeatureLink(id, 'system_protection', null, { beforeScripts: true, beforeRemoteTerminal: true }),
    ).rejects.toThrow();
    expect(m.inserted).toEqual([]);
  });

  it('updateFeatureLink stores the parsed settings', async () => {
    m.rows = [[link]];
    await updateFeatureLink(id, { inlineSettings: { beforePatching: false } }, id);
    expect(m.updated).toHaveLength(1);
    expect(m.updated[0].inlineSettings).toEqual({ ...DEFAULTS, beforePatching: false });
  });

  it('updateFeatureLink refuses a non-boolean toggle without writing', async () => {
    m.rows = [[link]];
    await expect(updateFeatureLink(id, { inlineSettings: { beforeScripts: 'yes' } }, id)).rejects.toThrow();
    expect(m.updated).toEqual([]);
  });

  it.each([
    { orgId: id, partnerId: null },
    { orgId: null, partnerId: id },
  ])('is inline-only for %j (partner-wide policies included)', async (owner) => {
    // A same-org configuration policy row exists, so only the inline-only
    // branch can refuse the id (otherwise the reference-integrity trigger 500s).
    m.rows = [[{ id }]];
    expect(await validateFeaturePolicyExists('system_protection', null, owner)).toEqual({ valid: true });
    const res = await validateFeaturePolicyExists('system_protection', id, owner);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/does not support featurePolicyId/);
  });
});
