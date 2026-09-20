import { describe, expect, it } from 'vitest';
import {
  resolveTopologySettings,
  TOPOLOGY_DEFAULT_CONFIGURATION,
} from './settingsResolver';
import type { TopologySettingsLayers } from './configurationTypes';
const id = '10000000-0000-4000-8000-000000000001';
const base = (): TopologySettingsLayers => ({
  defaultsVersion: 1,
  schemaVersion: 1,
  resolverVersion: 1,
  defaults: structuredClone(TOPOLOGY_DEFAULT_CONFIGURATION),
});
const tcp = {
  kind: 'tcp' as const,
  label: 'Check',
  enabled: true,
  families: ['ipv4' as const],
  provider: null,
  independenceLabel: null,
  host: 'check.example.test',
  port: 443,
};
describe('resolveTopologySettings', () => {
  it('preserves disabled scalars and reports exact layer provenance', () => {
    const input = base();
    input.partner = {
      versionId: id,
      payload: { passive: { enabled: false }, targets: {}, policies: {} },
    };
    const result = resolveTopologySettings(input);
    expect(result.settings.passive).toMatchObject({
      enabled: false,
      intervalSeconds: 300,
    });
    expect(result.provenance['passive.enabled']).toEqual({
      layer: 'partner',
      versionId: id,
    });
  });
  it('replaces entire named objects, handles tombstones and explicit restoration', () => {
    const input = base();
    input.partner = {
      versionId: id,
      payload: {
        targets: {
          check: {
            kind: 'https',
            label: 'Old',
            enabled: true,
            families: ['ipv4'],
            provider: null,
            independenceLabel: null,
            hostname: 'old.example.test',
            port: 443,
            path: '/health',
            method: 'HEAD',
            expectedStatus: 200,
            maxRedirects: 0,
            proxyMode: 'direct',
          },
        },
        policies: {},
      },
    };
    input.organization = {
      versionId: id,
      payload: { targets: { check: { kind: 'tombstone' } }, policies: {} },
    };
    input.site = { targets: { check: tcp }, policies: {} };
    const resolved = resolveTopologySettings(input);
    expect(resolved.settings.targets.check).toEqual(tcp);
    expect(resolved.settings.targets.check).not.toHaveProperty('path');
    expect(input.partner.payload.targets.check).toHaveProperty('path');
  });
  it('hashes resolved meaning and pinned versions without mutating input', () => {
    const input = base();
    const first = resolveTopologySettings(input);
    input.site = { targets: {}, policies: {} };
    expect(resolveTopologySettings(input).digest).toBe(first.digest);
    input.site.passive = { neighbors: false };
    expect(resolveTopologySettings(input).digest).not.toBe(first.digest);
    expect(() =>
      resolveTopologySettings({ ...input, defaultsVersion: 2 }),
    ).toThrow();
  });
  it('refuses unresolved policy targets after inheritance', () => {
    const input = base();
    input.site = {
      targets: {},
      policies: {
        check: {
          kind: 'policy',
          enabled: false,
          recipeId: 'target_connectivity',
          recipeVersion: 1,
          subject: 'configured_target',
          targetKeys: ['missing'],
          families: ['ipv4'],
          origin: 'eligible_collector',
          intervalSeconds: 300,
          jitterPercent: 10,
          alertsEnabled: false,
          failureThreshold: 3,
          recoveryThreshold: 2,
        },
      },
    };
    expect(() => resolveTopologySettings(input)).toThrow('Unresolved target');
  });
});
