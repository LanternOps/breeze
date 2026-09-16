import { describe, expect, it } from 'vitest';
import { assertM1PolicyActivation, topologyConfigurationSchema, topologyResolvedConfigurationSchema, topologyTargetDefinitionSchema } from './topologyConfiguration';
const target = { kind: 'https', label: 'Controlled endpoint', enabled: true, families: ['ipv4'], provider: null, independenceLabel: null, hostname: 'status.example.test', port: 443, path: '/health', method: 'HEAD', expectedStatus: 200, maxRedirects: 0, proxyMode: 'direct' };
const policy = { kind: 'policy', enabled: false, recipeId: 'internet_basic', recipeVersion: 1, subject: 'configured_target', targetKeys: ['check'], families: ['ipv4'], origin: 'eligible_collector', intervalSeconds: 300, jitterPercent: 10, alertsEnabled: false, failureThreshold: 3, recoveryThreshold: 2 };
describe('topology configuration', () => {
  it('defaults to no active targets and preserves scalar inheritance', () => {
    expect(topologyConfigurationSchema.parse({})).toEqual({ targets: {}, policies: {} });
    expect(topologyConfigurationSchema.parse({ passive: { enabled: false } }).passive).toEqual({ enabled: false });
  });
  it('separates inheritable layer references from effective configuration validation', () => {
    expect(topologyConfigurationSchema.safeParse({ policies: { outbound: policy } }).success).toBe(true);
    expect(topologyResolvedConfigurationSchema.safeParse({ policies: { outbound: policy } }).success).toBe(false);
    expect(topologyResolvedConfigurationSchema.safeParse({ targets: { check: target }, policies: { outbound: policy } }).success).toBe(true);
    expect(topologyResolvedConfigurationSchema.safeParse({ targets: { check: { kind: 'tombstone' } }, policies: { outbound: policy } }).success).toBe(false);
  });
  it.each([{ hostname: 'https://user:pass@example.test' }, { hostname: '*.example.test' }, { method: 'POST' }, { path: '//metadata' }, { path: '/#fragment' }, { maxRedirects: 3 }, { port: 0 }, { credentials: 'secret' }, { siteId: '10000000-0000-4000-8000-000000000001' }])('rejects unsafe target %j', patch => expect(topologyTargetDefinitionSchema.safeParse({ ...target, ...patch }).success).toBe(false));
  it('bounds named records and rejects concrete selectors, null and extra fields', () => {
    expect(topologyConfigurationSchema.safeParse({ targets: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`target${i}`, target])) }).success).toBe(false);
    for (const payload of [{ targets: null }, { passive: { enabled: null } }, { script: 'x' }, { policies: { p: { ...policy, subject: 'device-123' } } }]) expect(topologyConfigurationSchema.safeParse(payload).success).toBe(false);
  });
  it('saves inert activation intent but requires explicit runtime capability rejection', () => {
    expect(topologyConfigurationSchema.safeParse({ policies: { p: { ...policy, enabled: true } } }).success).toBe(true);
    expect(() => assertM1PolicyActivation(true)).toThrow('capability_unavailable');
    expect(() => assertM1PolicyActivation(false)).not.toThrow();
  });
});
