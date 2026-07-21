import { describe, expect, it } from 'vitest';
import type { ExtensionManifestV1 } from '@breeze/extension-sdk';
import { buildRuntimeWebRegistry, type RuntimeWebRegistrySource } from './webRegistry';

/**
 * `buildRuntimeWebRegistry` is the pure projection from staged/active
 * extension snapshots + their retained web-bundle digest to the browser-safe
 * registry document `GET /api/v1/extensions/registry` serves. It must be
 * deterministic (byte-identical JSON across replicas) and it must NEVER leak
 * a field a browser has no business seeing (artifact URIs, trust keys,
 * filesystem paths, extension config).
 */

function manifest(over: Partial<ExtensionManifestV1> = {}): ExtensionManifestV1 {
  return {
    apiVersion: 'breeze.extensions/v1',
    name: 'demo',
    version: '1.0.0',
    routeNamespace: 'demo',
    requires: { breeze: '^1.0.0', serverSdk: '^1.0.0', capabilities: [] },
    server: { entry: 'server/index.cjs' },
    migrationsDir: 'migrations',
    schemaCompatibilityFloor: '1.0.0',
    jobs: [],
    aiTools: [],
    tenancy: { orgCascadeDeleteTables: [], deviceCascadeDeleteTables: [], deviceOrgDenormalizedTables: [] },
    ...over,
  } as ExtensionManifestV1;
}

function source(over: Partial<RuntimeWebRegistrySource> = {}): RuntimeWebRegistrySource {
  return {
    name: 'demo',
    version: '1.0.0',
    digest: `sha256:${'a'.repeat(64)}`,
    manifest: manifest(),
    ...over,
  };
}

describe('buildRuntimeWebRegistry', () => {
  it('produces the fixed envelope shape', () => {
    const registry = buildRuntimeWebRegistry([]);
    expect(registry.apiVersion).toBe('breeze.extensions.web/v1');
    expect(typeof registry.revision).toBe('string');
    expect(registry.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.extensions).toEqual([]);
  });

  it('skips extensions with no manifest.web declared', () => {
    const registry = buildRuntimeWebRegistry([source({ manifest: manifest({ web: undefined }) })]);
    expect(registry.extensions).toEqual([]);
  });

  it('projects only browser-safe public fields for a web extension', () => {
    const registry = buildRuntimeWebRegistry([
      source({
        name: 'demo',
        version: '2.3.4',
        digest: `sha256:${'b'.repeat(64)}`,
        manifest: manifest({
          name: 'demo',
          version: '2.3.4',
          web: {
            entry: 'web/index.js',
            pages: [{ id: 'home', path: '/demo/home', element: 'demo-home' }],
            navigation: [{ id: 'nav-home', label: 'Demo', path: '/demo/home', order: 1 }],
            slots: [
              {
                id: 'tab-1',
                slot: 'device.detail.tabs',
                contractVersion: 1,
                element: 'demo-tab',
                label: 'Demo tab',
              },
            ],
          },
        }),
      }),
    ]);

    expect(registry.extensions).toHaveLength(1);
    const ext = registry.extensions[0]!;
    expect(ext).toEqual({
      name: 'demo',
      version: '2.3.4',
      digest: `sha256:${'b'.repeat(64)}`,
      moduleUrl: `/api/v1/extensions/assets/demo/sha256:${'b'.repeat(64)}/web/index.js`,
      pages: [{ id: 'home', path: '/demo/home', element: 'demo-home' }],
      navigation: [{ id: 'nav-home', label: 'Demo', path: '/demo/home', order: 1 }],
      slots: [
        {
          id: 'tab-1',
          slot: 'device.detail.tabs',
          contractVersion: 1,
          element: 'demo-tab',
          label: 'Demo tab',
        },
      ],
    });
  });

  it('NEVER leaks artifact URIs, trust keys, filesystem paths, or extension config', () => {
    const registry = buildRuntimeWebRegistry([
      source({
        manifest: manifest({
          web: {
            entry: 'web/index.js',
            pages: [{ id: 'home', path: '/demo/home', element: 'demo-home' }],
            navigation: [],
            slots: [],
          },
        }),
      }),
    ]);
    const text = JSON.stringify(registry);
    // Forbidden field NAMES must never appear as keys in the serialized output.
    for (const forbidden of ['root', 'archivePath', 'uri', 'publicKey', 'config', 'requires', 'server', 'tenancy']) {
      expect(text).not.toContain(`"${forbidden}"`);
    }
  });

  it('sorts extensions by name', () => {
    const registry = buildRuntimeWebRegistry([
      source({
        name: 'zebra',
        manifest: manifest({
          name: 'zebra',
          web: { entry: 'web/index.js', pages: [], navigation: [], slots: [] },
        }),
      }),
      source({
        name: 'alpha',
        manifest: manifest({
          name: 'alpha',
          web: { entry: 'web/index.js', pages: [], navigation: [], slots: [] },
        }),
      }),
    ]);
    expect(registry.extensions.map((e) => e.name)).toEqual(['alpha', 'zebra']);
  });

  it('sorts each extension pages/navigation/slots by contribution id', () => {
    const registry = buildRuntimeWebRegistry([
      source({
        manifest: manifest({
          web: {
            entry: 'web/index.js',
            pages: [
              { id: 'zzz', path: '/demo/z', element: 'demo-z' },
              { id: 'aaa', path: '/demo/a', element: 'demo-a' },
            ],
            navigation: [
              { id: 'zzz-nav', label: 'Z', path: '/demo/z' },
              { id: 'aaa-nav', label: 'A', path: '/demo/a' },
            ],
            slots: [
              { id: 'zzz-slot', slot: 'device.detail.tabs', contractVersion: 1, element: 'demo-z-slot' },
              { id: 'aaa-slot', slot: 'device.detail.tabs', contractVersion: 1, element: 'demo-a-slot' },
            ],
          },
        }),
      }),
    ]);
    const ext = registry.extensions[0]!;
    expect(ext.pages.map((p) => p.id)).toEqual(['aaa', 'zzz']);
    expect(ext.navigation.map((n) => n.id)).toEqual(['aaa-nav', 'zzz-nav']);
    expect(ext.slots.map((s) => s.id)).toEqual(['aaa-slot', 'zzz-slot']);
  });

  it('is deterministic: same input twice yields byte-identical JSON and the same revision', () => {
    const build = () =>
      buildRuntimeWebRegistry([
        source({
          manifest: manifest({
            web: {
              entry: 'web/index.js',
              pages: [{ id: 'home', path: '/demo/home', element: 'demo-home' }],
              navigation: [],
              slots: [],
            },
          }),
        }),
      ]);
    const first = build();
    const second = build();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.revision).toBe(second.revision);
  });

  it('revision changes when the projected content changes', () => {
    const base = source({
      manifest: manifest({
        web: { entry: 'web/index.js', pages: [], navigation: [], slots: [] },
      }),
    });
    const changed = source({
      version: '9.9.9',
      manifest: manifest({
        version: '9.9.9',
        web: { entry: 'web/index.js', pages: [], navigation: [], slots: [] },
      }),
    });
    expect(buildRuntimeWebRegistry([base]).revision).not.toBe(
      buildRuntimeWebRegistry([changed]).revision,
    );
  });

  it('handles multiple extensions with mixed web/non-web manifests', () => {
    const registry = buildRuntimeWebRegistry([
      source({ name: 'no-web', manifest: manifest({ name: 'no-web', web: undefined }) }),
      source({
        name: 'has-web',
        manifest: manifest({
          name: 'has-web',
          web: { entry: 'web/index.js', pages: [], navigation: [], slots: [] },
        }),
      }),
    ]);
    expect(registry.extensions.map((e) => e.name)).toEqual(['has-web']);
  });
});
