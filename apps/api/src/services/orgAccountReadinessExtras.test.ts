import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./orgAccountReadinessIntegrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./orgAccountReadinessIntegrations')>();
  return { ...actual, loadIntegrationReadiness: vi.fn() };
});
vi.mock('./orgAccountReadinessCommercial', () => ({ loadActiveContractCounts: vi.fn(), loadBackupReadiness: vi.fn() }));
vi.mock('../db', () => ({ db: { select: vi.fn(), selectDistinct: vi.fn() } }));

import { loadIntegrationReadiness } from './orgAccountReadinessIntegrations';
import { loadActiveContractCounts, loadBackupReadiness } from './orgAccountReadinessCommercial';
import { computeAccountReadinessExtras, extrasForOrg, EMPTY_EXTRAS } from './orgAccountReadinessExtras';

const NOW = new Date('2026-09-13T12:00:00.000Z');
const ORG_A = '11111111-1111-4111-8111-111111111111';
const CAPS_ALL = { integrations: true, contracts: true, backup: true };
const GRANTS = { accounting: true, pax8: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadIntegrationReadiness).mockResolvedValue({
    connectors: [{ system: 'quickbooks', state: 'connected' }],
    byOrg: new Map([[ORG_A, [{ system: 'quickbooks', state: 'linked' }]]]),
  });
  vi.mocked(loadActiveContractCounts).mockResolvedValue(new Map([[ORG_A, 1]]));
  vi.mocked(loadBackupReadiness).mockResolvedValue({ applicable: true, configuredOrgIds: new Set([ORG_A]) });
});

describe('computeAccountReadinessExtras', () => {
  it('loads every section when every capability is on and forwards the sub-grants', async () => {
    const extras = await computeAccountReadinessExtras({ partnerId: 'p', orgIds: [ORG_A], capabilities: CAPS_ALL, grants: GRANTS, now: NOW });
    expect(loadIntegrationReadiness).toHaveBeenCalledWith({ partnerId: 'p', orgIds: [ORG_A], grants: GRANTS, now: NOW });
    expect(loadActiveContractCounts).toHaveBeenCalledWith([ORG_A]);
    expect(loadBackupReadiness).toHaveBeenCalledWith('p', [ORG_A]);
    expect(extras.connectors).toEqual([{ system: 'quickbooks', state: 'connected' }]);
    expect(extras.integrationsByOrg?.get(ORG_A)).toEqual([{ system: 'quickbooks', state: 'linked' }]);
    expect(extras.activeContracts?.get(ORG_A)).toBe(1);
    expect(extras.backup?.applicable).toBe(true);
  });

  it('withholds a section — and never queries it — when its capability is off', async () => {
    const extras = await computeAccountReadinessExtras({
      partnerId: 'p', orgIds: [ORG_A], capabilities: { integrations: false, contracts: false, backup: false }, grants: GRANTS, now: NOW,
    });
    expect(loadIntegrationReadiness).not.toHaveBeenCalled();
    expect(loadActiveContractCounts).not.toHaveBeenCalled();
    expect(loadBackupReadiness).not.toHaveBeenCalled();
    expect(extras).toEqual(EMPTY_EXTRAS);
  });
});

describe('extrasForOrg', () => {
  it('returns the org\'s fields from every loaded section', async () => {
    const extras = await computeAccountReadinessExtras({ partnerId: 'p', orgIds: [ORG_A], capabilities: CAPS_ALL, grants: GRANTS, now: NOW });
    expect(extrasForOrg(ORG_A, extras)).toEqual({
      integrations: [{ system: 'quickbooks', state: 'linked' }],
      activeContracts: 1,
      backupApplicable: true,
      backupConfigured: true,
    });
  });

  it('fills [] / 0 / false for an org absent from a loaded section and omits withheld sections', () => {
    expect(extrasForOrg(ORG_A, {
      connectors: [],
      integrationsByOrg: new Map(),
      activeContracts: new Map(),
      backup: { applicable: false, configuredOrgIds: new Set() },
    })).toEqual({ integrations: [], activeContracts: 0, backupApplicable: false, backupConfigured: false });
    expect(extrasForOrg(ORG_A, EMPTY_EXTRAS)).toEqual({});
  });
});
