import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseExtensionManifestV1,
  type BreezeExtensionV1,
  type ExtensionManifestV1,
} from '@breeze/extension-api';
import {
  checkExtensionCompatibility,
  type ExtensionHostDescriptor,
} from './compatibility';
import { ExtensionContributionRegistry } from './contributionRegistry';

const fixtureDirectory = new URL(
  '../../../../packages/extension-sdk/fixtures/v1/minimal/',
  import.meta.url,
);

function isBreezeExtensionV1(candidate: unknown): candidate is BreezeExtensionV1 {
  return typeof candidate === 'object'
    && candidate !== null
    && 'register' in candidate
    && typeof candidate.register === 'function';
}

function makeManifest(
  overrides: Partial<ExtensionManifestV1> = {},
): ExtensionManifestV1 {
  const manifest = parseExtensionManifestV1({
    apiVersion: 'breeze.extensions/v1',
    name: 'compat-demo',
    version: '1.0.0',
    routeNamespace: 'compat-demo',
    requires: {
      breeze: '^1.0.0',
      serverSdk: '^1.0.0',
      capabilities: ['server.routes.v1'],
    },
    server: { entry: 'server/index.cjs' },
    schemaCompatibilityFloor: '1.0.0',
    jobs: [],
    aiTools: [],
    ...overrides,
  });

  return manifest;
}

function makeHost(
  overrides: Partial<ExtensionHostDescriptor> = {},
): ExtensionHostDescriptor {
  return {
    apiVersions: ['breeze.extensions/v1'],
    breezeVersion: '1.2.0',
    serverSdkVersion: '1.0.0',
    webSdkVersion: '1.0.0',
    capabilities: ['server.routes.v1'],
    slots: {},
    ...overrides,
  };
}

describe('checkExtensionCompatibility', () => {
  it('accepts supported API, version ranges, capabilities, and slot contracts', () => {
    const manifest = makeManifest({
      requires: {
        breeze: '^1.0.0',
        serverSdk: '^1.0.0',
        webSdk: '^1.0.0',
        capabilities: ['server.routes.v1', 'web.slots.v1'],
      },
      web: {
        entry: 'web/index.js',
        pages: [],
        navigation: [],
        slots: [
          { slot: 'device.detail.tabs', contractVersion: 1, element: 'compat-demo-tab' },
        ],
      },
    });

    expect(checkExtensionCompatibility(manifest, makeHost({
      capabilities: ['server.routes.v1', 'web.slots.v1'],
      slots: { 'device.detail.tabs': [1] },
    }))).toEqual({ compatible: true, reasons: [] });
  });

  it('rejects a missing capability and an unsupported slot version', () => {
    const result = checkExtensionCompatibility(makeManifest({
      requires: {
        breeze: '^1.0.0',
        serverSdk: '^1.0.0',
        webSdk: '^1.0.0',
        capabilities: ['server.routes.v1', 'server.jobs.v1'],
      },
      web: {
        entry: 'web/index.js',
        pages: [],
        navigation: [],
        slots: [
          { slot: 'device.detail.tabs', contractVersion: 2, element: 'compat-demo-tab' },
        ],
      },
    }), makeHost({
      capabilities: ['server.routes.v1'],
      slots: { 'device.detail.tabs': [1] },
    }));

    expect(result).toEqual({
      compatible: false,
      reasons: [
        'missing capability server.jobs.v1',
        'unsupported slot device.detail.tabs@2',
      ],
    });
  });

  it('reports unsupported manifest and host version ranges in contract order', () => {
    const manifest = makeManifest({
      requires: {
        breeze: '^2.0.0',
        serverSdk: '^2.0.0',
        webSdk: '^2.0.0',
        capabilities: ['server.routes.v1'],
      },
      web: { entry: 'web/index.js', pages: [], navigation: [], slots: [] },
    });

    expect(checkExtensionCompatibility(manifest, makeHost({ apiVersions: [] }))).toEqual({
      compatible: false,
      reasons: [
        'unsupported manifest API breeze.extensions/v1',
        'unsupported Breeze range ^2.0.0',
        'unsupported server SDK range ^2.0.0',
        'unsupported web SDK range ^2.0.0',
      ],
    });
  });
});

describe('SDK v1 release fixture', () => {
  it('parses, passes compatibility, loads through the adapter, and stages immutably', async () => {
    const rawManifest = JSON.parse(readFileSync(
      new URL('manifest.json', fixtureDirectory),
      'utf8',
    ));
    // Import from @breeze/extension-api intentionally exercises the legacy-to-v1
    // compatibility adapter that remains supported during the v1 release window.
    const manifest = parseExtensionManifestV1(rawManifest);

    expect(checkExtensionCompatibility(manifest, makeHost({
      capabilities: [...manifest.requires.capabilities],
    }))).toEqual({ compatible: true, reasons: [] });

    const entryUrl = pathToFileURL(fileURLToPath(new URL(manifest.server.entry, fixtureDirectory)));
    const loaded = await import(entryUrl.href) as {
      default?: BreezeExtensionV1 | { default?: BreezeExtensionV1 };
      extension?: BreezeExtensionV1;
    };
    const nestedDefault = loaded.default && 'default' in loaded.default
      ? loaded.default.default
      : undefined;
    const candidates: unknown[] = [nestedDefault, loaded.default, loaded.extension];
    const extension = candidates.find(isBreezeExtensionV1);
    expect(extension).toBeDefined();

    const registry = new ExtensionContributionRegistry();
    const session = registry.begin(manifest);
    await extension!.register(session.registrar, {
      db: { execute: async () => [] },
      secrets: {
        encryptForColumn: (_table, _column, plaintext) => plaintext,
        decryptForColumn: (_table, _column, ciphertext) => ciphertext,
      },
      audit: async () => undefined,
      log: () => undefined,
      config: {},
    });
    const staged = session.finish();

    expect(registry.get(manifest.name)).toBeUndefined();
    expect(staged).toMatchObject({
      name: manifest.name,
      version: manifest.version,
      enabled: true,
    });
    expect(staged.routeApp).not.toBeNull();
    expect(Object.isFrozen(staged)).toBe(true);
  });
});
