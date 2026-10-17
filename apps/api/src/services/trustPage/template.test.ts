import { describe, expect, it, vi, beforeEach } from 'vitest';

const dbm = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn(), update: vi.fn() }));
vi.mock('../../db', () => ({ db: dbm }));

import { loadPartnerTemplate, savePartnerTemplate, templateRowToSettings } from './template';

/** Thenable query-builder stand-in: every builder method records its args and returns itself; awaiting yields `result`. */
function chain(result: unknown, calls: Array<[string, unknown[]]> = []): unknown {
  const proxy: unknown = new Proxy(function () { /* target */ }, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
      return (...args: unknown[]) => { calls.push([String(prop), args]); return proxy; };
    },
  });
  return proxy;
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 't1', partnerId: 'p1', introHtml: null, searchIndexable: null, showPercentages: true, showDeviceCount: null,
  showManagedBy: false, showHistory: null, hiddenControlIds: ['mfa_enforced_m365', 'not_a_control'], frameworkView: ['nist_csf_2', 'bogus'],
  revision: 3, updatedByUserId: 'u', createdAt: new Date(), updatedAt: new Date(), ...over,
});

const FULL = { scope: 'partner' as const, partnerOrgAccess: 'all' as const };

beforeEach(() => { dbm.select.mockReset(); dbm.insert.mockReset(); dbm.update.mockReset(); });

describe('templateRowToSettings', () => {
  it('maps every inheritable key and drops ids the catalog no longer knows', () => {
    expect(templateRowToSettings(row() as never)).toEqual({
      introHtml: null, searchIndexable: null, showPercentages: true, showDeviceCount: null, showManagedBy: false,
      showHistory: null, hiddenControlIds: ['mfa_enforced_m365'], frameworkView: ['nist_csf_2'],
    });
  });

  it("keeps '' (template says: no intro) distinct from null (not set)", () => {
    expect(templateRowToSettings(row({ introHtml: '' }) as never).introHtml).toBe('');
  });
});

describe('loadPartnerTemplate', () => {
  it('returns null when the partner has no template row', async () => {
    dbm.select.mockReturnValueOnce(chain([]));
    await expect(loadPartnerTemplate('p1')).resolves.toBeNull();
  });

  it('returns the settings and the revision', async () => {
    dbm.select.mockReturnValueOnce(chain([row()]));
    const t = await loadPartnerTemplate('p1');
    expect(t?.revision).toBe(3);
    expect(t?.settings.showManagedBy).toBe(false);
  });
});

describe('savePartnerTemplate', () => {
  it('refuses a caller without the partner-wide capability before touching the db', async () => {
    await expect(savePartnerTemplate({ partnerId: 'p1', expectedRevision: 0, patch: {}, actorUserId: 'u', actor: { scope: 'partner', partnerOrgAccess: 'selected' } }))
      .rejects.toMatchObject({ name: 'PartnerWideWriteDeniedError' });
    await expect(savePartnerTemplate({ partnerId: 'p1', expectedRevision: 0, patch: {}, actorUserId: 'u', actor: { scope: 'organization' } as never }))
      .rejects.toMatchObject({ name: 'PartnerWideWriteDeniedError' });
    expect(dbm.insert).not.toHaveBeenCalled();
    expect(dbm.update).not.toHaveBeenCalled();
  });

  it('expectedRevision 0 upserts (first save creates revision 1) guarded on revision = 0', async () => {
    const calls: Array<[string, unknown[]]> = [];
    let inserted: Record<string, unknown> | undefined;
    dbm.insert.mockReturnValueOnce({ values: (v: Record<string, unknown>) => { inserted = v; return chain([row({ revision: 1, showManagedBy: false })], calls); } });
    const out = await savePartnerTemplate({ partnerId: 'p1', expectedRevision: 0, patch: { showManagedBy: false }, actorUserId: 'u', actor: FULL });
    expect(out).toMatchObject({ ok: true, revision: 1 });
    expect(inserted).toMatchObject({ partnerId: 'p1', showManagedBy: false, revision: 1, updatedByUserId: 'u' });
    const conflict = calls.find(([m]) => m === 'onConflictDoUpdate')?.[1][0] as { setWhere?: unknown; set: Record<string, unknown> };
    expect(conflict).toBeDefined();
    expect(conflict.setWhere).toBeDefined();
    expect(conflict.set).toMatchObject({ showManagedBy: false, updatedByUserId: 'u' });
    expect(dbm.update).not.toHaveBeenCalled();
  });

  it('expectedRevision 0 against an existing row (revision ≥ 1) is a mismatch', async () => {
    dbm.insert.mockReturnValueOnce({ values: () => chain([]) });
    await expect(savePartnerTemplate({ partnerId: 'p1', expectedRevision: 0, patch: {}, actorUserId: 'u', actor: FULL }))
      .resolves.toEqual({ ok: false, reason: 'REVISION_MISMATCH' });
  });

  it('a later save is a conditional UPDATE; zero rows back = stale revision', async () => {
    let set: Record<string, unknown> | undefined;
    dbm.update.mockReturnValueOnce({ set: (v: Record<string, unknown>) => { set = v; return chain([]); } });
    await expect(savePartnerTemplate({ partnerId: 'p1', expectedRevision: 2, patch: { introHtml: '' }, actorUserId: 'u', actor: FULL }))
      .resolves.toEqual({ ok: false, reason: 'REVISION_MISMATCH' });
    expect(set).toMatchObject({ introHtml: '', updatedByUserId: 'u' });
    expect(set?.revision).toBeDefined();
    expect(dbm.insert).not.toHaveBeenCalled();
  });

  it('a matching later save returns the bumped revision', async () => {
    dbm.update.mockReturnValueOnce({ set: () => chain([row({ revision: 4 })]) });
    await expect(savePartnerTemplate({ partnerId: 'p1', expectedRevision: 3, patch: { showHistory: null }, actorUserId: 'u', actor: FULL }))
      .resolves.toMatchObject({ ok: true, revision: 4 });
  });
});
