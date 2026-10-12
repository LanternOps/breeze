import { describe, expect, it, vi, beforeEach } from 'vitest';

const { selectRows, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } = vi.hoisted(() => ({
  selectRows: { value: [] as unknown[] },
  getCurrentDbAccessContext: vi.fn(() => undefined as { scope: string } | undefined),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => selectRows.value) })),
        })),
      })),
    })),
  },
  getCurrentDbAccessContext,
  withSystemDbAccessContext,
  runOutsideDbContext,
}));
vi.mock('../db/schema', () => ({
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId', deletedAt: 'organizations.deletedAt' },
  partners: { id: 'partners.id', settings: 'partners.settings', deletedAt: 'partners.deletedAt' },
}));
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, isNull: vi.fn(actual.isNull), and: vi.fn(actual.and) };
});

import { isNull } from 'drizzle-orm';
import {
  TUNNEL_ORIGIN_PARTNER_DEFAULT,
  isTunnelOriginEnabledForOrg,
  tunnelOriginOptInFromSettings,
} from './tunnelOriginOptIn';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('tunnelOriginOptInFromSettings', () => {
  it('is off by default until PSL inclusion is verified', () => {
    expect(TUNNEL_ORIGIN_PARTNER_DEFAULT).toBe(false);
    expect(tunnelOriginOptInFromSettings(null)).toBe(false);
    expect(tunnelOriginOptInFromSettings({})).toBe(false);
    expect(tunnelOriginOptInFromSettings({ networkProxy: {} })).toBe(false);
  });

  it('honours an explicit partner value either way', () => {
    expect(tunnelOriginOptInFromSettings({ networkProxy: { dedicatedTunnelOrigin: true } })).toBe(true);
    expect(tunnelOriginOptInFromSettings({ networkProxy: { dedicatedTunnelOrigin: false } })).toBe(false);
  });

  it('ignores a non-boolean value instead of treating it as truthy', () => {
    expect(tunnelOriginOptInFromSettings({ networkProxy: { dedicatedTunnelOrigin: 'yes' } })).toBe(false);
    expect(tunnelOriginOptInFromSettings({ networkProxy: 'on' })).toBe(false);
  });
});

describe('isTunnelOriginEnabledForOrg', () => {
  beforeEach(() => {
    selectRows.value = [];
    getCurrentDbAccessContext.mockReset();
    getCurrentDbAccessContext.mockReturnValue(undefined);
    runOutsideDbContext.mockClear();
    withSystemDbAccessContext.mockClear();
    vi.mocked(isNull).mockClear();
  });

  it('reads the org\'s partner settings', async () => {
    selectRows.value = [{ settings: { networkProxy: { dedicatedTunnelOrigin: true } } }];
    expect(await isTunnelOriginEnabledForOrg(ORG_ID)).toBe(true);
  });

  it('fails closed when the org or partner is missing', async () => {
    selectRows.value = [];
    expect(await isTunnelOriginEnabledForOrg(ORG_ID)).toBe(false);
  });

  it('filters soft-deleted orgs and partners out of the join', async () => {
    selectRows.value = [];
    expect(await isTunnelOriginEnabledForOrg(ORG_ID)).toBe(false);
    expect(isNull).toHaveBeenCalledWith('organizations.deletedAt');
    expect(isNull).toHaveBeenCalledWith('partners.deletedAt');
  });

  it('reads through readWithPartnerAxisVisibility: escapes RLS when the ambient scope is not system', async () => {
    getCurrentDbAccessContext.mockReturnValue({ scope: 'organization' });
    selectRows.value = [{ settings: { networkProxy: { dedicatedTunnelOrigin: true } } }];
    expect(await isTunnelOriginEnabledForOrg(ORG_ID)).toBe(true);
    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it('skips the escape when the ambient scope is already system (no double-held connection)', async () => {
    getCurrentDbAccessContext.mockReturnValue({ scope: 'system' });
    selectRows.value = [{ settings: { networkProxy: { dedicatedTunnelOrigin: true } } }];
    expect(await isTunnelOriginEnabledForOrg(ORG_ID)).toBe(true);
    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });
});
