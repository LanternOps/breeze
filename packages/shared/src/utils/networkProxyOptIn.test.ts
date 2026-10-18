import { describe, expect, it } from 'vitest';
import { TUNNEL_ORIGIN_PARTNER_DEFAULT, tunnelOriginOptInFromSettings } from './networkProxyOptIn';
import * as shared from '../index';

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

  it('is exported from the package root (the API resolver and the web toggle share it)', () => {
    expect(shared.tunnelOriginOptInFromSettings).toBe(tunnelOriginOptInFromSettings);
    expect(shared.TUNNEL_ORIGIN_PARTNER_DEFAULT).toBe(TUNNEL_ORIGIN_PARTNER_DEFAULT);
  });
});
