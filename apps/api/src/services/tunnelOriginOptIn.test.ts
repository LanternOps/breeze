import { describe, expect, it, vi, beforeEach } from 'vitest';

const { selectRows } = vi.hoisted(() => ({ selectRows: { value: [] as unknown[] } }));
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
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../db/schema', () => ({
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  partners: { id: 'partners.id', settings: 'partners.settings' },
}));

import {
  TUNNEL_ORIGIN_PARTNER_DEFAULT,
  isTunnelOriginEnabledForOrg,
  tunnelOriginOptInFromSettings,
} from './tunnelOriginOptIn';

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
  beforeEach(() => { selectRows.value = []; });

  it('reads the org\'s partner settings', async () => {
    selectRows.value = [{ settings: { networkProxy: { dedicatedTunnelOrigin: true } } }];
    expect(await isTunnelOriginEnabledForOrg('11111111-1111-4111-8111-111111111111')).toBe(true);
  });

  it('fails closed when the org or partner is missing', async () => {
    selectRows.value = [];
    expect(await isTunnelOriginEnabledForOrg('11111111-1111-4111-8111-111111111111')).toBe(false);
  });
});
