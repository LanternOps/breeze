import { describe, it, expect, vi, beforeEach } from 'vitest';

// A `where(...)` result that is BOTH awaitable directly AND carries a
// `.returning()` method — both writers use the zero-row-write guard, and the
// direct-await shape is kept so the mock stays valid if a future caller drops
// it. Defaults to one row so a test that doesn't care about the returning
// value still reads as "the write took effect"; pass `[]` to model a 0-row
// UPDATE (RLS rejected it, or the row vanished between the SELECT and the
// UPDATE).
function updateWhereResult(returningRows: unknown[] = [{ id: 'stub-id' }]) {
  const result: Promise<undefined> & { returning?: ReturnType<typeof vi.fn> } = Promise.resolve(undefined);
  result.returning = vi.fn().mockResolvedValue(returningRows);
  return result;
}

const dbMock = vi.hoisted(() => {
  const selectWhere = vi.fn();
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const updateWhere = vi.fn(() => updateWhereResult());
  const updateSet = vi.fn((_values: Record<string, unknown>) => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  return { select, selectFrom, selectWhere, update, updateSet, updateWhere };
});

vi.mock('../db', () => ({ db: { select: dbMock.select, update: dbMock.update } }));
vi.mock('../db/schema', () => ({
  organizations: { id: 'organizations.id', settings: 'organizations.settings' },
  sites: { id: 'sites.id', orgId: 'sites.org_id', settings: 'sites.settings' },
}));

// Wrap drizzle's condition builders in spies (real implementation preserved)
// so tests can assert the actual org/site-scoping WHERE predicates the
// service builds, not just the mocked query's return value — matching the
// pattern already used by routes/software.test.ts. Without this, deleting
// `eq(sites.orgId, orgId)` from a query's WHERE clause leaves every test
// green: the mocked `.where()` ignores its argument entirely and just
// returns whatever `selectWhere`/`updateWhere` was scripted to return.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return { ...actual, eq: vi.fn(actual.eq), and: vi.fn(actual.and) };
});

// Real implementation preserved (it's a safe no-op pass-through for a
// payload with no secret-shaped keys — see SECRET_JSON_KEYS), spied so
// tests can assert BOTH writers actually route through it. organizations
// .settings / sites.settings are registered encrypted-JSON columns
// (encryptedColumnRegistry.ts); skipping this helper on a write silently
// downgrades the column to plaintext for the next secret stored under an
// unrelated settings key.
vi.mock('./encryptedColumnRegistry', async () => {
  const actual = await vi.importActual<typeof import('./encryptedColumnRegistry')>(
    './encryptedColumnRegistry',
  );
  return { ...actual, encryptColumnValueForWrite: vi.fn(actual.encryptColumnValueForWrite) };
});

import { eq } from 'drizzle-orm';
import { organizations, sites } from '../db/schema';
import { encryptColumnValueForWrite } from './encryptedColumnRegistry';
import {
  getOrganizationSoftwareDownloadPolicy,
  getSiteSoftwareDownloadPolicy,
  getEffectiveSoftwareDownloadPolicy,
  setOrganizationSoftwareDownloadPolicy,
  setSiteSoftwareDownloadPolicy,
} from './softwareDownloadPolicy';

/** Count of `eq(column, value)` calls matching exactly — used to prove a
 *  scoping predicate is present at EACH call site (e.g. both the SELECT and
 *  the UPDATE), not just somewhere in the function. */
function eqCallCount(column: unknown, value: unknown): number {
  return vi.mocked(eq).mock.calls.filter(([c, v]) => c === column && v === value).length;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getOrganizationSoftwareDownloadPolicy', () => {
  it('returns the empty default policy when no org row is found', async () => {
    dbMock.selectWhere.mockResolvedValueOnce([]);
    expect(await getOrganizationSoftwareDownloadPolicy('org-1')).toEqual({
      version: 1,
      approvedPrivateOrigins: [],
    });
  });

  it('returns the empty default policy when settings has no softwareDownloadPolicy key', async () => {
    dbMock.selectWhere.mockResolvedValueOnce([{ settings: { unrelated: 'x' } }]);
    expect(await getOrganizationSoftwareDownloadPolicy('org-1')).toEqual({
      version: 1,
      approvedPrivateOrigins: [],
    });
  });

  it('returns the stored policy when present and valid', async () => {
    dbMock.selectWhere.mockResolvedValueOnce([
      { settings: { softwareDownloadPolicy: { version: 1, approvedPrivateOrigins: ['https://a.corp.internal'] } } },
    ]);
    expect(await getOrganizationSoftwareDownloadPolicy('org-1')).toEqual({
      version: 1,
      approvedPrivateOrigins: ['https://a.corp.internal'],
    });
    // The read is scoped to the requested org — proves the predicate exists,
    // not just that SOME row was returned.
    expect(eqCallCount(organizations.id, 'org-1')).toBe(1);
  });

  it('falls back to the empty policy when the stored value no longer validates', async () => {
    dbMock.selectWhere.mockResolvedValueOnce([
      { settings: { softwareDownloadPolicy: { version: 2, approvedPrivateOrigins: ['not a url'] } } },
    ]);
    expect(await getOrganizationSoftwareDownloadPolicy('org-1')).toEqual({
      version: 1,
      approvedPrivateOrigins: [],
    });
  });
});

describe('getSiteSoftwareDownloadPolicy', () => {
  it('returns { ok: false } when the site row is not found (wrong org or missing)', async () => {
    dbMock.selectWhere.mockResolvedValueOnce([]);
    expect(await getSiteSoftwareDownloadPolicy('org-1', 'site-1')).toEqual({
      ok: false,
      error: 'site_not_found',
    });
  });

  it('returns the site policy when found', async () => {
    dbMock.selectWhere.mockResolvedValueOnce([
      { settings: { softwareDownloadPolicy: { version: 1, approvedPrivateOrigins: ['https://site.corp.internal'] } } },
    ]);
    expect(await getSiteSoftwareDownloadPolicy('org-1', 'site-1')).toEqual({
      ok: true,
      policy: { version: 1, approvedPrivateOrigins: ['https://site.corp.internal'] },
    });
  });

  it('scopes the read to BOTH the requested site id and the requested org id', async () => {
    // Deleting either `eq(sites.id, siteId)` or `eq(sites.orgId, orgId)` from
    // the WHERE clause would let a caller read (or, via the sibling "not
    // found" test's mirror, be told "not found" for) a site belonging to a
    // different organization. Assert both predicates are actually built,
    // not just that the mocked query happens to return the scripted rows.
    dbMock.selectWhere.mockResolvedValueOnce([{ settings: {} }]);
    await getSiteSoftwareDownloadPolicy('org-1', 'site-1');

    expect(eqCallCount(sites.id, 'site-1')).toBe(1);
    expect(eqCallCount(sites.orgId, 'org-1')).toBe(1);
  });
});

describe('setOrganizationSoftwareDownloadPolicy', () => {
  it('preserves unrelated settings keys when merging the policy in', async () => {
    dbMock.selectWhere.mockResolvedValueOnce([
      { settings: { timezone: 'America/New_York', defaults: { agentVersionPins: {} } } },
    ]);

    const policy = { version: 1 as const, approvedPrivateOrigins: ['https://files.corp.internal'] };
    const result = await setOrganizationSoftwareDownloadPolicy('org-1', policy);

    expect(result).toEqual({ ok: true, policy });
    expect(dbMock.updateSet).toHaveBeenCalledTimes(1);
    const setArg = dbMock.updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.settings).toEqual({
      timezone: 'America/New_York',
      defaults: { agentVersionPins: {} },
      softwareDownloadPolicy: policy,
    });
    // Scoped to the requested org at BOTH the read (merge source) and the
    // write (UPDATE ... WHERE) — 2 occurrences, one per call site. A missing
    // predicate at either site would leave this at 1 (or 0) without any
    // other assertion in this test catching it.
    expect(eqCallCount(organizations.id, 'org-1')).toBe(2);
    // The write routes through the encrypted-column helper — organizations
    // .settings is a registered encrypted-JSON column — with the merged
    // (unrelated-keys-preserved) settings object as the input.
    expect(encryptColumnValueForWrite).toHaveBeenCalledWith('organizations', 'settings', {
      timezone: 'America/New_York',
      defaults: { agentVersionPins: {} },
      softwareDownloadPolicy: policy,
    });
  });

  it('writes the policy even when the org has no prior settings object', async () => {
    dbMock.selectWhere.mockResolvedValueOnce([{ settings: null }]);
    const policy = { version: 1 as const, approvedPrivateOrigins: [] };

    await setOrganizationSoftwareDownloadPolicy('org-1', policy);

    const setArg = dbMock.updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.settings).toEqual({ softwareDownloadPolicy: policy });
  });

  it('returns { ok: false } and never writes when the organization does not exist', async () => {
    dbMock.selectWhere.mockResolvedValueOnce([]);

    const result = await setOrganizationSoftwareDownloadPolicy('missing-org', {
      version: 1,
      approvedPrivateOrigins: [],
    });

    expect(result).toEqual({ ok: false, error: 'organization_not_found' });
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('returns { ok: false } instead of a phantom success when the UPDATE affects 0 rows', async () => {
    // The SELECT found a row (so the merge/write proceeds), but the UPDATE's
    // own RETURNING comes back empty — an RLS/app mismatch or a race where
    // the row vanished between the two statements. This must not read as
    // success: the caller (and the audit trail) would otherwise believe an
    // allowlist is in force when nothing actually persisted.
    dbMock.selectWhere.mockResolvedValueOnce([{ settings: {} }]);
    dbMock.updateWhere.mockReturnValueOnce(updateWhereResult([]));

    const result = await setOrganizationSoftwareDownloadPolicy('org-1', {
      version: 1,
      approvedPrivateOrigins: [],
    });

    expect(result).toEqual({ ok: false, error: 'organization_not_found' });
  });
});

describe('setSiteSoftwareDownloadPolicy', () => {
  it('preserves unrelated site settings keys when merging the policy in', async () => {
    // First select() call is the site lookup inside setSiteSoftwareDownloadPolicy.
    dbMock.selectWhere.mockResolvedValueOnce([
      { settings: { customLabel: 'Building A' } },
    ]);
    // Second select() call is the org lookup for the effective-union response.
    dbMock.selectWhere.mockResolvedValueOnce([{ settings: {} }]);

    const policy = { version: 1 as const, approvedPrivateOrigins: ['https://site.corp.internal'] };
    const result = await setSiteSoftwareDownloadPolicy('org-1', 'site-1', policy);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy).toEqual(policy);

    const setArg = dbMock.updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.settings).toEqual({
      customLabel: 'Building A',
      softwareDownloadPolicy: policy,
    });
    // Scoped to the requested site AND org at both the read (site lookup)
    // and the write (UPDATE ... WHERE) — 2 occurrences each. Deleting
    // `eq(sites.orgId, orgId)` from either the SELECT or the UPDATE would
    // drop this to 1 without failing any other assertion in this test.
    expect(eqCallCount(sites.id, 'site-1')).toBe(2);
    expect(eqCallCount(sites.orgId, 'org-1')).toBe(2);
    // The write routes through the encrypted-column helper — sites.settings
    // is a registered encrypted-JSON column.
    expect(encryptColumnValueForWrite).toHaveBeenCalledWith('sites', 'settings', {
      customLabel: 'Building A',
      softwareDownloadPolicy: policy,
    });
  });

  it('returns { ok: false } and never writes when the site does not belong to the org', async () => {
    dbMock.selectWhere.mockResolvedValueOnce([]);

    const result = await setSiteSoftwareDownloadPolicy('org-1', 'site-in-other-org', {
      version: 1,
      approvedPrivateOrigins: [],
    });

    expect(result).toEqual({ ok: false, error: 'site_not_found' });
    expect(dbMock.update).not.toHaveBeenCalled();
    // The lookup that produced this "not found" was itself scoped to the
    // requested org — proves the empty result came from the org predicate
    // actually being applied, not merely from an unscoped miss.
    expect(eqCallCount(sites.id, 'site-in-other-org')).toBe(1);
    expect(eqCallCount(sites.orgId, 'org-1')).toBe(1);
  });

  it('returns { ok: false } instead of a phantom success when the site UPDATE affects 0 rows', async () => {
    // Mirror of the organization writer's guard. The site SELECT found a row,
    // but the UPDATE's RETURNING is empty (RLS refused the write, or the row
    // vanished between the two statements). Reporting ok:true here makes the
    // route answer 200 and emit a `software.downloadPolicy.site.update` audit
    // row for a policy change that never persisted.
    // Only the site lookup is scripted — deliberately. With the guard in
    // place the org lookup for the effective union is never reached; delete
    // the guard and this test fails on that unscripted second SELECT, which
    // is itself the proof that a guarded implementation short-circuits first.
    // (A second `mockResolvedValueOnce` cannot be added here: `clearAllMocks`
    // does not drain an unconsumed once-queue, so it would leak into the
    // following tests.)
    dbMock.selectWhere.mockResolvedValueOnce([{ settings: {} }]);
    dbMock.updateWhere.mockReturnValueOnce(updateWhereResult([]));

    const result = await setSiteSoftwareDownloadPolicy('org-1', 'site-1', {
      version: 1,
      approvedPrivateOrigins: ['https://site.corp.internal'],
    });

    expect(result).toEqual({ ok: false, error: 'site_not_found' });
    // No effective-union lookup either: a failed write must not be followed by
    // a read that makes the response look like a real post-write state.
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });

  it('returns the org∪site union as the effective policy, deduped', async () => {
    dbMock.selectWhere.mockResolvedValueOnce([{ settings: {} }]); // site lookup (pre-write)
    dbMock.selectWhere.mockResolvedValueOnce([
      {
        settings: {
          softwareDownloadPolicy: {
            version: 1,
            approvedPrivateOrigins: ['https://org.corp.internal', 'https://shared.corp.internal'],
          },
        },
      },
    ]); // org lookup (post-write, for the union)

    const policy = {
      version: 1 as const,
      approvedPrivateOrigins: ['https://site-only.corp.internal', 'https://shared.corp.internal'],
    };
    const result = await setSiteSoftwareDownloadPolicy('org-1', 'site-1', policy);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effective.version).toBe(1);
    expect(new Set(result.effective.approvedPrivateOrigins)).toEqual(
      new Set(['https://org.corp.internal', 'https://shared.corp.internal', 'https://site-only.corp.internal']),
    );
    // Deduped: 3 distinct origins, not 4.
    expect(result.effective.approvedPrivateOrigins).toHaveLength(3);
  });
});

describe('getEffectiveSoftwareDownloadPolicy', () => {
  it('returns just the org policy when no siteId is given', async () => {
    dbMock.selectWhere.mockResolvedValueOnce([
      { settings: { softwareDownloadPolicy: { version: 1, approvedPrivateOrigins: ['https://org.corp.internal'] } } },
    ]);

    const result = await getEffectiveSoftwareDownloadPolicy('org-1');
    expect(result).toEqual({ version: 1, approvedPrivateOrigins: ['https://org.corp.internal'] });
  });

  it('returns the org policy alone when the site is not found', async () => {
    dbMock.selectWhere.mockResolvedValueOnce([
      { settings: { softwareDownloadPolicy: { version: 1, approvedPrivateOrigins: ['https://org.corp.internal'] } } },
    ]);
    dbMock.selectWhere.mockResolvedValueOnce([]); // site lookup misses

    const result = await getEffectiveSoftwareDownloadPolicy('org-1', 'missing-site');
    expect(result).toEqual({ version: 1, approvedPrivateOrigins: ['https://org.corp.internal'] });
  });
});

// ---------------------------------------------------------------------------
// Whole-branch review, Low #2 — a stored policy holding an entry that a LATER
// validator tightening invalidated must not switch the dispatch gate off for
// the whole org.
//
// Wave 6 added the numeric-looking-host rejection (`https://192.168.1.x`).
// Before this fix, extractPolicy discarded the ENTIRE list when any element
// failed, which is fail-closed on the agent (fewer approved origins) but
// fail-OPEN on the API gate: with an empty list a LAN destination stops being
// recognised as private, so compat mode dispatches the install to a
// capability-0 agent that has no dial-time policy of its own.
// ---------------------------------------------------------------------------
describe('extractPolicy salvage on a partially-invalid stored policy', () => {
  it('keeps the valid approved origins and drops only the invalid ones', async () => {
    dbMock.selectWhere.mockResolvedValueOnce([
      {
        settings: {
          softwareDownloadPolicy: {
            version: 1,
            approvedPrivateOrigins: [
              'https://192.168.1.x', // invalid: numeric-looking host
              'https://files.corp.internal',
              'https://10.0.0.5',
            ],
          },
        },
      },
    ]);

    const policy = await getOrganizationSoftwareDownloadPolicy('org-1');

    expect(policy.approvedPrivateOrigins).toEqual([
      'https://files.corp.internal',
      'https://10.0.0.5',
    ]);
  });

  it('degrades to empty when there is no origins array to salvage', async () => {
    dbMock.selectWhere.mockResolvedValueOnce([
      { settings: { softwareDownloadPolicy: { version: 9, nope: true } } },
    ]);

    const policy = await getOrganizationSoftwareDownloadPolicy('org-1');

    expect(policy.approvedPrivateOrigins).toEqual([]);
  });
});
