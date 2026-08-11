import { describe, expect, it } from 'vitest';
import { buildRemoteProxyPageUrl, buildRemoteVncPageUrl } from './remoteTunnelUrls';

describe('remote tunnel page URLs', () => {
  it('builds VNC browser fallback URLs without WebSocket tickets', () => {
    const url = buildRemoteVncPageUrl('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');

    expect(url).toBe('/remote/vnc/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    expect(url).not.toContain('ws=');
    expect(url).not.toContain('ticket=');
  });

  it('builds proxy page URLs with only the target in the query string', () => {
    const url = buildRemoteProxyPageUrl('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '10.0.0.5:443');

    expect(url).toBe('/remote/proxy/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee?target=10.0.0.5%3A443');
    expect(url).not.toContain('ws=');
    expect(url).not.toContain('ticket=');
    expect(url).not.toContain('ticket%3D');
  });

  it('appends the asset id when provided, for the network-device Back link', () => {
    const url = buildRemoteProxyPageUrl(
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      '10.0.0.5:443',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );

    expect(url).toBe(
      '/remote/proxy/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee?target=10.0.0.5%3A443&asset=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
  });

  it('omits the asset param entirely when not provided', () => {
    const url = buildRemoteProxyPageUrl('id-1', 'host:80');
    expect(url).not.toContain('asset=');
  });
});
