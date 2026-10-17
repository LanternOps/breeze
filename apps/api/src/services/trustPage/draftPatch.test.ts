import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SQL } from 'drizzle-orm';

const dbm = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('../../db', () => ({ db: dbm, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() }));

import { applyTrustPageDraftPatch, trustPagePortalDraftPatchSchema } from './draftPatch';

/** Thenable query-builder stand-in: every builder method returns itself; awaiting it yields `result`. */
function chain(result: unknown): unknown {
  const proxy: unknown = new Proxy(function () { /* target */ }, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
      return () => proxy;
    },
  });
  return proxy;
}

const PAGE_ROW = { id: 'pg', orgId: 'org', publicationRevision: 6, updatedByUserId: 'msp-user' };

function txLockedAt(rev: number, sets: Record<string, unknown>[], opts: { isPartnerHome?: boolean } = {}) {
  dbm.transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn({
    select: () => chain([{ rev, isPartnerHome: opts.isPartnerHome ?? false }]),
    update: () => ({ set: (v: Record<string, unknown>) => { sets.push(v); return chain([PAGE_ROW]); } }),
  }));
}

const actor = { kind: 'portal_user' as const, id: 'pu-1' };

beforeEach(() => dbm.transaction.mockReset());

describe('trustPagePortalDraftPatchSchema (Trust Center W3d)', () => {
  const ok = (v: unknown) => trustPagePortalDraftPatchSchema.safeParse(v).success;

  it('applies only the five portal fields: introHtml / isPartnerHome / embedAllowedOrigins are rejected', () => {
    expect(ok({ expectedRevision: 1, securityContactEmail: 'sec@example.com', websiteUrl: 'https://example.com', hiddenControlIds: ['dns_filtering'], showPercentages: true, showDeviceCount: false })).toBe(true);
    expect(ok({ expectedRevision: 1, introHtml: '<p>x</p>' })).toBe(false);
    expect(ok({ expectedRevision: 1, isPartnerHome: true })).toBe(false);
    expect(ok({ expectedRevision: 1, embedAllowedOrigins: ['https://example.com'] })).toBe(false);
    expect(ok({ expectedRevision: 1, searchIndexable: true })).toBe(false);
    expect(ok({ expectedRevision: 1, showManagedBy: true })).toBe(false);
  });

  it('requires expectedRevision and at least one field', () => {
    expect(ok({ securityContactEmail: 'sec@example.com' })).toBe(false);
    expect(ok({ expectedRevision: 1 })).toBe(false);
  });

  it('hiddenControlIds validated against TELEMETRY_CONTROL_IDS', () => {
    expect(ok({ expectedRevision: 1, hiddenControlIds: ['not_a_control'] })).toBe(false);
    expect(ok({ expectedRevision: 1, hiddenControlIds: [] })).toBe(true);
  });

  it('websiteUrl https only, contact email max 320', () => {
    expect(ok({ expectedRevision: 1, websiteUrl: 'http://example.com' })).toBe(false);
    expect(ok({ expectedRevision: 1, websiteUrl: 'javascript:alert(1)' })).toBe(false);
    expect(ok({ expectedRevision: 1, websiteUrl: null })).toBe(true);
    expect(ok({ expectedRevision: 1, securityContactEmail: `${'a'.repeat(310)}@example.com` })).toBe(false);
    expect(ok({ expectedRevision: 1, securityContactEmail: 'not-an-email' })).toBe(false);
    expect(ok({ expectedRevision: 1, securityContactEmail: null })).toBe(true);
  });

  it('the exposure toggles take explicit booleans only (no null = inherit from the portal)', () => {
    expect(ok({ expectedRevision: 1, showPercentages: null })).toBe(false);
    expect(ok({ expectedRevision: 1, showDeviceCount: null })).toBe(false);
  });
});

describe('applyTrustPageDraftPatch', () => {
  it('writes exactly the patched fields and bumps publication_revision', async () => {
    const sets: Record<string, unknown>[] = [];
    txLockedAt(5, sets);
    const row = await applyTrustPageDraftPatch('pg', { expectedRevision: 5, securityContactEmail: 'sec@example.com', showDeviceCount: false }, actor);
    expect(row).toEqual(PAGE_ROW);
    expect(sets).toHaveLength(1);
    const set = sets[0]!;
    expect(Object.keys(set).sort()).toEqual(['publicationRevision', 'securityContactEmail', 'showDeviceCount', 'updatedAt'].sort());
    expect(set.securityContactEmail).toBe('sec@example.com');
    expect(set.showDeviceCount).toBe(false);
    expect(set.publicationRevision).toBeInstanceOf(SQL);
  });

  it('does not overwrite updated_by_user_id (portal users are not users; attribution is in the audit entry)', async () => {
    const sets: Record<string, unknown>[] = [];
    txLockedAt(5, sets);
    await applyTrustPageDraftPatch('pg', { expectedRevision: 5, websiteUrl: 'https://example.com' }, actor);
    expect(sets[0]).not.toHaveProperty('updatedByUserId');
  });

  it('a stale expectedRevision is 409 REVISION_MISMATCH and nothing is written', async () => {
    const sets: Record<string, unknown>[] = [];
    txLockedAt(5, sets);
    await expect(applyTrustPageDraftPatch('pg', { expectedRevision: 4, websiteUrl: 'https://example.com' }, actor))
      .rejects.toMatchObject({ status: 409, code: 'REVISION_MISMATCH' });
    expect(sets).toHaveLength(0);
  });

  it('a partner-home page is refused (403) and nothing is written', async () => {
    const sets: Record<string, unknown>[] = [];
    txLockedAt(5, sets, { isPartnerHome: true });
    await expect(applyTrustPageDraftPatch('pg', { expectedRevision: 5, websiteUrl: 'https://example.com' }, actor))
      .rejects.toMatchObject({ status: 403, code: 'PORTAL_TRUST_EDITOR_REQUIRED' });
    expect(sets).toHaveLength(0);
  });

  it('a missing page is a 404', async () => {
    dbm.transaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn({ select: () => chain([]) }));
    await expect(applyTrustPageDraftPatch('pg', { expectedRevision: 0, websiteUrl: null }, actor)).rejects.toMatchObject({ status: 404 });
  });

  it('re-validates its input: a field outside the subset never opens a transaction', async () => {
    const err = await applyTrustPageDraftPatch('pg', { expectedRevision: 5, introHtml: '<p>x</p>' } as never, actor).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain('introHtml');
    expect(dbm.transaction).not.toHaveBeenCalled();
  });
});
