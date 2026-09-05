import { describe, expect, it } from 'vitest';
import type { ExtensionManifestV1 } from '@breeze/extension-sdk';
import {
  buildRuntimeWebRegistry,
  type ExtensionAssetTokenMinter,
  type RuntimeWebRegistrySource,
} from './webRegistry';

/**
 * `buildRuntimeWebRegistry` is the pure projection from staged/active
 * extension snapshots + their retained web-bundle digest to the browser-safe
 * registry document `GET /api/v1/extensions/registry` serves. It must be
 * deterministic (byte-identical JSON across replicas) and it must NEVER leak
 * a field a browser has no business seeing (artifact URIs, trust keys,
 * filesystem paths, extension config).
 */

/** Deterministic stub minter for tests: `{name, digest}` -> a readable, unique token. */
const mint: ExtensionAssetTokenMinter = (b) => `tok-${b.name}-${b.digest}`;

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
    const registry = buildRuntimeWebRegistry([], mint);
    expect(registry.apiVersion).toBe('breeze.extensions.web/v1');
    expect(typeof registry.revision).toBe('string');
    expect(registry.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.extensions).toEqual([]);
  });

  it('skips extensions with no manifest.web declared', () => {
    const registry = buildRuntimeWebRegistry([source({ manifest: manifest({ web: undefined }) })], mint);
    expect(registry.extensions).toEqual([]);
  });

  it('projects only browser-safe public fields for a web extension', () => {
    const registry = buildRuntimeWebRegistry(
      [
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
      ],
      mint,
    );

    expect(registry.extensions).toHaveLength(1);
    const ext = registry.extensions[0]!;
    expect(ext).toEqual({
      name: 'demo',
      version: '2.3.4',
      digest: `sha256:${'b'.repeat(64)}`,
      moduleUrl: `/api/v1/extensions/assets/t/tok-demo-sha256:${'b'.repeat(64)}/demo/sha256:${'b'.repeat(64)}/web/index.js`,
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
    const registry = buildRuntimeWebRegistry(
      [
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
      ],
      mint,
    );
    const text = JSON.stringify(registry);
    // Forbidden field NAMES must never appear as keys in the serialized output.
    for (const forbidden of ['root', 'archivePath', 'uri', 'publicKey', 'config', 'requires', 'server', 'tenancy']) {
      expect(text).not.toContain(`"${forbidden}"`);
    }
  });

  it('sorts extensions by name', () => {
    const registry = buildRuntimeWebRegistry(
      [
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
      ],
      mint,
    );
    expect(registry.extensions.map((e) => e.name)).toEqual(['alpha', 'zebra']);
  });

  it('sorts each extension pages/navigation/slots by contribution id', () => {
    const registry = buildRuntimeWebRegistry(
      [
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
      ],
      mint,
    );
    const ext = registry.extensions[0]!;
    expect(ext.pages.map((p) => p.id)).toEqual(['aaa', 'zzz']);
    expect(ext.navigation.map((n) => n.id)).toEqual(['aaa-nav', 'zzz-nav']);
    expect(ext.slots.map((s) => s.id)).toEqual(['aaa-slot', 'zzz-slot']);
  });

  it('is deterministic: same input twice yields byte-identical JSON and the same revision', () => {
    const build = () =>
      buildRuntimeWebRegistry(
        [
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
        ],
        mint,
      );
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
    expect(buildRuntimeWebRegistry([base], mint).revision).not.toBe(
      buildRuntimeWebRegistry([changed], mint).revision,
    );
  });

  it('handles multiple extensions with mixed web/non-web manifests', () => {
    const registry = buildRuntimeWebRegistry(
      [
        source({ name: 'no-web', manifest: manifest({ name: 'no-web', web: undefined }) }),
        source({
          name: 'has-web',
          manifest: manifest({
            name: 'has-web',
            web: { entry: 'web/index.js', pages: [], navigation: [], slots: [] },
          }),
        }),
      ],
      mint,
    );
    expect(registry.extensions.map((e) => e.name)).toEqual(['has-web']);
  });

  it('calls the asset-token minter with exactly {name, digest} of the source, once per projected (web) extension', () => {
    const calls: Array<{ name: string; digest: string }> = [];
    const trackingMint: ExtensionAssetTokenMinter = (binding) => {
      calls.push(binding);
      return mint(binding);
    };

    buildRuntimeWebRegistry(
      [
        source({
          name: 'alpha',
          digest: `sha256:${'a'.repeat(64)}`,
          manifest: manifest({
            name: 'alpha',
            web: { entry: 'web/index.js', pages: [], navigation: [], slots: [] },
          }),
        }),
        source({
          name: 'beta',
          digest: `sha256:${'c'.repeat(64)}`,
          manifest: manifest({
            name: 'beta',
            web: { entry: 'web/index.js', pages: [], navigation: [], slots: [] },
          }),
        }),
        // No `web` block projected at all -> must never reach the minter.
        source({ name: 'no-web', manifest: manifest({ name: 'no-web', web: undefined }) }),
      ],
      trackingMint,
    );

    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual({ name: 'alpha', digest: `sha256:${'a'.repeat(64)}` });
    expect(calls).toContainEqual({ name: 'beta', digest: `sha256:${'c'.repeat(64)}` });
  });

  it('changes the revision when only the minted token changes, sources held identical', () => {
    // This is load-bearing, not incidental: the token is deliberately hashed
    // INTO the revision (see the DETERMINISM paragraph in webRegistry.ts) so
    // that a rollover to a fresh signed asset token always produces a new
    // revision. The browser client keys its in-memory module cache off the
    // revision; if the token were excluded from the hash, two buckets with
    // otherwise-identical sources would collide on one revision and the
    // client's revision-keyed memo could hand back moduleUrls carrying an
    // already-expired token instead of fetching the fresh one.
    const sources = [
      source({
        manifest: manifest({
          web: { entry: 'web/index.js', pages: [], navigation: [], slots: [] },
        }),
      }),
    ];
    const first = buildRuntimeWebRegistry(sources, () => 'token-bucket-1');
    const second = buildRuntimeWebRegistry(sources, () => 'token-bucket-2');

    expect(first.extensions[0]!.moduleUrl).not.toBe(second.extensions[0]!.moduleUrl);
    expect(first.revision).not.toBe(second.revision);
  });

  it('produces the identical revision across two calls when sources AND the minted token are the same (cross-replica determinism)', () => {
    // Two replicas that agree on which extensions are active AND land in the
    // same token time-bucket must still agree byte-for-byte on the revision
    // (see DETERMINISM in webRegistry.ts) — otherwise a client polling
    // through a load balancer would see the document "change" for no reason.
    const sources = [
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
    ];
    const first = buildRuntimeWebRegistry(sources, mint);
    const second = buildRuntimeWebRegistry(sources, mint);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.revision).toBe(second.revision);
  });
});
