import { describe, expect, it } from 'vitest';
import { mappedOrgIds, reusablePrincipals, windowsOfSource, type ImportSource, type MigrationWindow, type ServicePrincipal } from './ticketImportApi';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const principal = (over: Partial<ServicePrincipal>): ServicePrincipal => ({
  id: 'p-1', name: 'Import: Zammad', status: 'active', scopes: ['tickets:write'], expiresAt: null,
  owner: { id: 'me', name: 'Me' }, keys: [], ...over,
});
const source = (over: Partial<ImportSource> = {}): ImportSource => ({
  id: 's-1', partnerId: 'pa', module: 'zammad', label: 'Zammad', baseUrl: 'https://helpdesk.example.com', principalId: 'p-1',
  ownerUserId: 'me', options: {}, hasCredentials: true, revokedAt: null, revokedBy: null, createdBy: 'me',
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', activeRunId: null, ...over,
});
const win = (over: Partial<MigrationWindow>): MigrationWindow => ({
  id: 'w-1', partnerId: 'pa', principalId: 'p-1', sourceLabel: 'Zammad', status: 'closed', openedAt: '2026-11-01T00:00:00Z',
  endsAt: '2026-11-05T00:00:00Z', writesPerHour: 6000, openedBy: 'me', closedBy: null, closedReason: 'expired', closedAt: '2026-11-05T00:00:00Z',
  orgIds: ['o-1'], counts: { orgs: [], ticketsImported: 0, commentsImported: 0, attachmentsImported: 0 }, ...over,
});

describe('reusablePrincipals (#8313 W6)', () => {
  it('offers only active, unexpired, keyless tickets:write principals the caller owns that have no source', () => {
    const list = [
      principal({ id: 'ok' }),
      principal({ id: 'other-owner', owner: { id: 'you', name: null } }),
      principal({ id: 'disabled', status: 'disabled' }),
      principal({ id: 'expired', expiresAt: '2026-11-01T00:00:00Z' }),
      principal({ id: 'no-scope', scopes: ['tickets:read'] }),
      principal({ id: 'keyed', keys: [{ id: 'k', status: 'active', expiresAt: null }] }),
      principal({ id: 'expired-key', keys: [{ id: 'k', status: 'active', expiresAt: '2026-11-01T00:00:00Z' }] }),
      principal({ id: 'bound' }),
    ];
    const ids = reusablePrincipals(list, [source({ principalId: 'bound' })], 'me', NOW).map((p) => p.id);
    expect(ids).toEqual(['ok', 'expired-key']);
    expect(reusablePrincipals(list, [], null, NOW)).toEqual([]);
  });
});

describe('windowsOfSource (#8313 W6)', () => {
  it("returns the principal's open window and its newest one, ignoring other principals'", () => {
    const windows = [
      win({ id: 'old', openedAt: '2026-10-01T00:00:00Z' }),
      win({ id: 'open', status: 'open', openedAt: '2026-11-10T00:00:00Z', closedReason: null, closedAt: null }),
      win({ id: 'foreign', principalId: 'p-2', status: 'open', openedAt: '2026-11-11T00:00:00Z' }),
    ];
    expect(windowsOfSource(windows, source())).toMatchObject({ open: { id: 'open' }, latest: { id: 'open' } });
    expect(windowsOfSource([windows[0]!], source())).toMatchObject({ open: null, latest: { id: 'old' } });
    expect(windowsOfSource(windows, null)).toEqual({ open: null, latest: null });
  });
});

describe('mappedOrgIds (#8313 W6)', () => {
  it('is every mapped org and the fallback, once each, sorted', () => {
    expect(mappedOrgIds({
      orgs: [
        { sourceOrgKey: '2', sourceOrgName: 'B', orgId: 'o-b' },
        { sourceOrgKey: '1', sourceOrgName: 'A', orgId: 'o-a' },
        { sourceOrgKey: '3', sourceOrgName: 'A2', orgId: 'o-a' },
        { sourceOrgKey: null, sourceOrgName: null, orgId: 'o-c' },
      ],
      categories: [],
    })).toEqual(['o-a', 'o-b', 'o-c']);
    expect(mappedOrgIds(null)).toEqual([]);
  });
});
