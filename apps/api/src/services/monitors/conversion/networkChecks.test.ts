import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../../middleware/auth';
import { mapNetworkMonitorToDefinition, missingNetworkCheckPrerequisites, previewNetworkCheckConversion, convertNetworkChecks, networkPreviewHash } from './networkChecks';
vi.mock('./convert', () => ({ inCallerTransaction: vi.fn(), lockConversion: vi.fn() }));
const row = (over: Record<string, unknown> = {}) => ({ id: 'nm', orgId: 'org', managedByMonitorId: null, assetId: null, siteId: null, name: 'Gateway', monitorType: 'icmp_ping', target: 'example.com', config: { count: 4 }, pollingInterval: 60, timeout: 5, isActive: true, retiredAt: null, ...over }) as never;
const rule = (over: Record<string, unknown> = {}) => ({ id: 'rule', monitorId: 'nm', condition: 'offline', threshold: null, severity: 'high', message: null, isActive: true, retiredAt: null, ...over }) as never;
describe('network conversion mapper', () => {
  it('preserves the probe and exact offline predicate', () => expect(mapNetworkMonitorToDefinition(row(), [rule()])).toMatchObject({ ok: true, mapping: { severity: 'high', deliveryMode: 'inherit', condition: { checkType: 'icmp_ping', count: 4, consecutiveFailures: 1, degradedIsFailure: false } } }));
  it('pins legacy redirect default even for expected 3xx', () => expect(mapNetworkMonitorToDefinition(row({ monitorType: 'http_check', config: { url: 'https://example.com', expectedStatus: 302 } }), [rule()])).toMatchObject({ ok: true, mapping: { condition: { target: 'https://example.com', expectStatus: 302, followRedirects: true } } }));
  it.each([
    [[], 'no_active_rules'], [[rule({ isActive: false })], 'no_active_rules'],
    [[rule(), rule()], 'multiple_network_rules'], [[rule({ condition: 'degraded' })], 'network_predicate_unsupported'],
    [[rule({ condition: 'response_time_gt' })], 'network_predicate_unsupported'],
    [[rule({ condition: 'consecutive_failures_gt', threshold: '100' })], 'network_threshold_out_of_range'],
  ])('refuses unsupported rules', (rules, reason) => expect(mapNetworkMonitorToDefinition(row(), rules)).toEqual({ ok: false, reason: `unconvertible:${reason}` }));
  it('preserves strict fractional thresholds', () => expect(mapNetworkMonitorToDefinition(row(), [rule({ condition: 'consecutive_failures_gt', threshold: '4.5' })])).toMatchObject({ mapping: { condition: { consecutiveFailures: 5 } } }));
  it.each([
    ['tcp_port', { port: 443, expectBanner: 'ready' }, { port: 443, expectBanner: 'ready' }],
    ['dns_check', { hostname: 'dns.example.com', recordType: 'AAAA', expectedValue: '::1', nameserver: '1.1.1.1' }, { target: 'dns.example.com', recordType: 'AAAA', expectedValue: '::1', nameserver: '1.1.1.1' }],
    ['http_check', { url: 'https://example.com', method: 'HEAD', expectedBody: 'ok', headers: { 'X-Test': 'yes' }, followRedirects: false, verifySsl: false }, { method: 'HEAD', expectedBody: 'ok', headers: { 'X-Test': 'yes' }, followRedirects: false, verifySsl: false }],
    ['icmp_ping', { packetSize: 128, count: 4, ignored: true }, { packetSize: 128, count: 4 }],
  ])('preserves %s options', (monitorType, config, condition) => expect(mapNetworkMonitorToDefinition(row({ monitorType, config }), [rule()])).toMatchObject({ ok: true, mapping: { condition } }));
  it.each(['', '-1', 'NaN', 'Infinity'])('rejects invalid threshold %s', threshold => expect(mapNetworkMonitorToDefinition(row(), [rule({ condition: 'consecutive_failures_gt', threshold })])).toMatchObject({ ok: false, reason: 'unconvertible:network_threshold_out_of_range' }));
  it('rejects managed and partner-wide rows', () => {
    expect(mapNetworkMonitorToDefinition(row({ managedByMonitorId: 'definition' }), [])).toMatchObject({ reason: 'unconvertible:already_managed' });
    expect(mapNetworkMonitorToDefinition(row({ orgId: null }), [])).toMatchObject({ reason: 'unconvertible:no_org' });
  });
  it('refuses site-only bindings', () => expect(mapNetworkMonitorToDefinition(row({ siteId: 'site' }), [rule()])).toEqual({ ok: false, reason: 'unconvertible:site_binding_unrepresentable' }));
  it('refuses invalid ranges', () => expect(mapNetworkMonitorToDefinition(row({ pollingInterval: 5 }), [rule()])).toMatchObject({ ok: false, reason: 'unconvertible:condition_invalid' }));
  it('hashes authoring inputs, excluding live observations', () => {
    const rules = new Map([['nm', [rule()]]]);
    const hash = networkPreviewHash([row()], rules);
    expect(networkPreviewHash([row({ updatedAt: new Date(), lastStatus: 'offline', consecutiveFailures: 9 })], rules)).toBe(hash);
    expect(networkPreviewHash([row({ target: 'other.example.com' })], rules)).not.toBe(hash);
    expect(networkPreviewHash([row()], new Map([['nm', [rule({ message: 'changed' })]]]))).not.toBe(hash);
  });
});
it.each([{ allowedSiteIds: [] }, { allowedSiteIds: ['site'] }])('rejects site ceilings before DB reads', async ({ allowedSiteIds }) => {
  const auth = { scope: 'organization', allowedSiteIds, canAccessOrg: () => true } as unknown as AuthContext;
  await expect(previewNetworkCheckConversion('org', auth)).rejects.toMatchObject({ code: 'site_restricted_conversion', status: 403 });
  await expect(convertNetworkChecks('org', 'a'.repeat(64), auth)).rejects.toMatchObject({ code: 'site_restricted_conversion', status: 403 });
});
it.each([{}, { NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION: false }])('requires capability', runtime => expect(missingNetworkCheckPrerequisites(runtime)).toHaveLength(1));
it('accepts real runtime capability', () => expect(missingNetworkCheckPrerequisites()).toEqual([]));
