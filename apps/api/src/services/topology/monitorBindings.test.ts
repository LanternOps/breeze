import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {}, withDbTransaction: vi.fn() }));

import { topologyMonitorEquivalence } from './monitorBindings';

const siteId = '22222222-2222-4222-8222-222222222222';
const tcp = { kind: 'tcp', label: 'web', enabled: true, families: ['ipv4'], provider: null, independenceLabel: null, host: '198.51.100.7', port: 443 } as const;
const https = { kind: 'https', label: 'app', enabled: true, families: ['ipv4'], provider: null, independenceLabel: null, hostname: 'app.example.com', port: 443,
  path: '/health', method: 'GET', expectedStatus: 200, maxRedirects: 0, proxyMode: 'direct' } as const;
const monitor = { siteId, isActive: true, monitorType: 'tcp_port', target: '198.51.100.7', config: { port: 443 } };
const policy = (target: unknown, recipeId = 'target_connectivity') => ({ recipeId, targets: [target as never] });

describe('topologyMonitorEquivalence (M3-D5)', () => {
  it('accepts an exact tcp destination/port/protocol/site match', () => {
    expect(topologyMonitorEquivalence(policy(tcp), { siteId, family: 'ipv4' }, monitor)).toEqual({ equivalent: true, metricRole: 'port_reachability' });
  });

  it.each([
    ['another port', { ...monitor, config: { port: 8443 } }, 'destination_mismatch'],
    ['another host', { ...monitor, target: '198.51.100.8' }, 'destination_mismatch'],
    ['another protocol', { ...monitor, monitorType: 'icmp_ping' }, 'protocol_mismatch'],
    ['a null-site legacy monitor', { ...monitor, siteId: null }, 'monitor_site_mismatch'],
    ['another site', { ...monitor, siteId: '33333333-3333-4333-8333-333333333333' }, 'monitor_site_mismatch'],
    ['a disabled monitor', { ...monitor, isActive: false }, 'monitor_disabled'],
  ])('refuses %s', (_label, candidate, reason) => {
    expect(topologyMonitorEquivalence(policy(tcp), { siteId, family: 'ipv4' }, candidate)).toEqual({ equivalent: false, reason });
  });

  it('refuses the wrong address family and missing evidence', () => {
    expect(topologyMonitorEquivalence(policy(tcp), { siteId, family: 'ipv6' }, monitor)).toEqual({ equivalent: false, reason: 'family_mismatch' });
    expect(topologyMonitorEquivalence({ recipeId: 'target_connectivity', targets: [] }, { siteId, family: 'ipv4' }, monitor)).toEqual({ equivalent: false, reason: 'target_not_configured' });
    expect(topologyMonitorEquivalence(policy(tcp, 'gateway_basic'), { siteId, family: 'ipv4' }, monitor)).toEqual({ equivalent: false, reason: 'recipe_not_reusable' });
  });

  it('compares https scheme, host, port, path, method, status and redirect policy', () => {
    const http = { siteId, isActive: true, monitorType: 'http_check', target: 'https://app.example.com/health', config: { url: 'https://APP.example.com/health', expectedStatus: 200, followRedirects: false } };
    expect(topologyMonitorEquivalence(policy(https), { siteId, family: 'ipv4' }, http)).toEqual({ equivalent: true, metricRole: 'service_response' });
    for (const config of [
      { ...http.config, url: 'http://app.example.com/health' },
      { ...http.config, url: 'https://app.example.com/other' },
      { ...http.config, url: 'https://app.example.com:8443/health' },
      { ...http.config, expectedStatus: 204 },
      { ...http.config, method: 'POST' },
      { ...http.config, followRedirects: true },
    ]) {
      expect(topologyMonitorEquivalence(policy(https), { siteId, family: 'ipv4' }, { ...http, config })).toMatchObject({ equivalent: false });
    }
  });
});
