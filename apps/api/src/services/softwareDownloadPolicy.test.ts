import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => {
  const selectWhere = vi.fn();
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const updateWhere = vi.fn(() => Promise.resolve(undefined));
  const updateSet = vi.fn((_values: Record<string, unknown>) => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  return { select, selectFrom, selectWhere, update, updateSet, updateWhere };
});

vi.mock('../db', () => ({ db: { select: dbMock.select, update: dbMock.update } }));
vi.mock('../db/schema', () => ({
  organizations: { id: 'organizations.id', settings: 'organizations.settings' },
  sites: { id: 'sites.id', orgId: 'sites.org_id', settings: 'sites.settings' },
}));

import {
  getOrganizationSoftwareDownloadPolicy,
  getSiteSoftwareDownloadPolicy,
  getEffectiveSoftwareDownloadPolicy,
  setOrganizationSoftwareDownloadPolicy,
  setSiteSoftwareDownloadPolicy,
} from './softwareDownloadPolicy';

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
});

describe('setOrganizationSoftwareDownloadPolicy', () => {
  it('preserves unrelated settings keys when merging the policy in', async () => {
    dbMock.selectWhere.mockResolvedValueOnce([
      { settings: { timezone: 'America/New_York', defaults: { agentVersionPins: {} } } },
    ]);

    const policy = { version: 1 as const, approvedPrivateOrigins: ['https://files.corp.internal'] };
    const result = await setOrganizationSoftwareDownloadPolicy('org-1', policy);

    expect(result).toEqual(policy);
    expect(dbMock.updateSet).toHaveBeenCalledTimes(1);
    const setArg = dbMock.updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.settings).toEqual({
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
  });

  it('returns { ok: false } and never writes when the site does not belong to the org', async () => {
    dbMock.selectWhere.mockResolvedValueOnce([]);

    const result = await setSiteSoftwareDownloadPolicy('org-1', 'site-in-other-org', {
      version: 1,
      approvedPrivateOrigins: [],
    });

    expect(result).toEqual({ ok: false, error: 'site_not_found' });
    expect(dbMock.update).not.toHaveBeenCalled();
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
