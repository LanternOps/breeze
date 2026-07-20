import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseExtensionManifestV1,
  type ExtensionManifestV1,
} from '@breeze/extension-sdk';
import {
  HOST_BREEZE_VERSION,
  HOST_DESCRIPTOR,
  HOST_SERVER_SDK_VERSION,
  HOST_WEB_SDK_VERSION,
} from './hostDescriptor';
import {
  checkExtensionCompatibility,
  type ExtensionHostDescriptor,
} from './compatibility';

/**
 * hostDescriptor.ts pins the host's advertised versions as literal constants,
 * because the API image is bundled and cannot reliably read a package.json at
 * runtime. Its doc comment names the source of truth for each constant:
 *
 *   - HOST_SERVER_SDK_VERSION → packages/extension-sdk/package.json "version"
 *   - HOST_BREEZE_VERSION     → apps/api/package.json "version"
 *
 * "Kept in lockstep by review" is not a control. A stale constant makes every
 * `requires.serverSdk` / `requires.breeze` compatibility verdict wrong in BOTH
 * directions: a good bundle gets rejected, or an incompatible one gets admitted.
 * These tests read the real package.json files (never a hardcoded copy of the
 * number) so any drift fails here instead of shipping.
 */
function packageVersion(relativeToThisFile: string): string {
  const url = new URL(relativeToThisFile, import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'));
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${relativeToThisFile} has no usable "version" field`);
  }
  return version;
}

describe('host descriptor version constants', () => {
  it('HOST_SERVER_SDK_VERSION matches packages/extension-sdk/package.json', () => {
    expect(HOST_SERVER_SDK_VERSION).toBe(
      packageVersion('../../../../packages/extension-sdk/package.json'),
    );
  });

  it('HOST_BREEZE_VERSION matches apps/api/package.json', () => {
    expect(HOST_BREEZE_VERSION).toBe(packageVersion('../../package.json'));
  });

  it('HOST_WEB_SDK_VERSION matches packages/extension-web-sdk/package.json', () => {
    expect(HOST_WEB_SDK_VERSION).toBe(
      packageVersion('../../../../packages/extension-web-sdk/package.json'),
    );
  });

  it('advertises those same constants on the frozen descriptor', () => {
    // Guards the wiring as well as the values: a constant kept current but no
    // longer referenced by HOST_DESCRIPTOR would leave compatibility checks
    // reading a stale number from somewhere else.
    expect(HOST_DESCRIPTOR.serverSdkVersion).toBe(HOST_SERVER_SDK_VERSION);
    expect(HOST_DESCRIPTOR.breezeVersion).toBe(HOST_BREEZE_VERSION);
    expect(HOST_DESCRIPTOR.webSdkVersion).toBe(HOST_WEB_SDK_VERSION);
  });
});

/**
 * Regression coverage for the Plan 03 feature-blocking Critical: hostDescriptor.ts
 * used to set `webSdkVersion: undefined` on HOST_DESCRIPTOR, reasoning that "the
 * API tier serves no web assets" — a premise Task 3 made false (this API process
 * now serves `/api/v1/extensions/registry` and `/api/v1/extensions/assets/...`).
 * Because `requires.webSdk` is mandatory whenever a manifest declares a `web`
 * section, and `assertCompatible`/`checkExtensionCompatibility` is the ONLY
 * compatibility gate for the whole extension (web included — there is no separate
 * web-tier gate), an undefined `webSdkVersion` made EVERY web-declaring extension
 * report incompatible and never activate.
 *
 * These tests exercise the REAL HOST_DESCRIPTOR (not a `webSdkVersion` override,
 * unlike the slot-contract tests above) so they fail if `webSdkVersion` ever
 * regresses back to undefined.
 */
describe('HOST_DESCRIPTOR web SDK version gate (real descriptor, no override)', () => {
  function makeWebSdkManifest(webSdkRange: string): ExtensionManifestV1 {
    return parseExtensionManifestV1({
      apiVersion: 'breeze.extensions/v1',
      name: 'websdk-demo',
      version: '1.0.0',
      routeNamespace: 'websdk-demo',
      requires: {
        breeze: '*',
        serverSdk: '*',
        webSdk: webSdkRange,
        capabilities: [],
      },
      server: { entry: 'server/index.cjs' },
      web: { entry: 'web/index.js', pages: [], navigation: [], slots: [] },
      schemaCompatibilityFloor: '1.0.0',
      jobs: [],
      aiTools: [],
    });
  }

  it('accepts a requires.webSdk range satisfied by HOST_WEB_SDK_VERSION against the real HOST_DESCRIPTOR', () => {
    // Before the fix, HOST_DESCRIPTOR.webSdkVersion was undefined and this case
    // reported `unsupported web SDK range ^1.0.0` even though ^1.0.0 is trivially
    // satisfied by the intended 1.0.0 host version — proving the gate was broken
    // at the descriptor, not just under-tested.
    const manifest = makeWebSdkManifest('^1.0.0');

    expect(checkExtensionCompatibility(manifest, HOST_DESCRIPTOR))
      .toEqual({ compatible: true, reasons: [] });
  });

  it('rejects a requires.webSdk range NOT satisfied by HOST_WEB_SDK_VERSION against the real HOST_DESCRIPTOR', () => {
    const manifest = makeWebSdkManifest('^2.0.0');

    const result = checkExtensionCompatibility(manifest, HOST_DESCRIPTOR);

    expect(result.compatible).toBe(false);
    expect(result.reasons).toContain('unsupported web SDK range ^2.0.0');
  });
});

/**
 * Task 2: HOST_DESCRIPTOR.slots was `Object.freeze({})` by design (see the doc
 * comment above HOST_DESCRIPTOR) — every manifest declaring a web slot was
 * reported incompatible. These tests pin the populated contract and prove,
 * against the compatibility checker itself, that the population is what makes
 * a `device.detail.tabs@1` declaration pass — not some other relaxed check.
 */
describe('HOST_DESCRIPTOR web slot contracts', () => {
  function makeSlotManifest(
    slots: { slot: string; contractVersion: number; element: string }[],
  ): ExtensionManifestV1 {
    return parseExtensionManifestV1({
      apiVersion: 'breeze.extensions/v1',
      name: 'slot-demo',
      version: '1.0.0',
      routeNamespace: 'slot-demo',
      requires: {
        breeze: '*',
        serverSdk: '*',
        webSdk: '*',
        capabilities: ['web.slots.v1'],
      },
      server: { entry: 'server/index.cjs' },
      web: { entry: 'web/index.js', pages: [], navigation: [], slots },
      schemaCompatibilityFloor: '1.0.0',
      jobs: [],
      aiTools: [],
    });
  }

  // HOST_DESCRIPTOR already advertises a satisfying webSdkVersion (see
  // HOST_WEB_SDK_VERSION coverage above); pin it explicitly here too so these
  // slot-contract assertions stay isolated from that axis and keep passing
  // regardless of what HOST_WEB_SDK_VERSION is set to.
  function hostWithWebSdk(overrides: Partial<ExtensionHostDescriptor> = {}): ExtensionHostDescriptor {
    return { ...HOST_DESCRIPTOR, webSdkVersion: '1.0.0', ...overrides };
  }

  it('advertises exactly the device.detail.tabs and organization.settings.sections v1 contracts', () => {
    expect(HOST_DESCRIPTOR.slots).toEqual({
      'device.detail.tabs': [1],
      'organization.settings.sections': [1],
    });
  });

  it('TRIPWIRE: an empty slots map rejects device.detail.tabs@1 (proves population, not something else, makes it pass)', () => {
    const manifest = makeSlotManifest([
      { slot: 'device.detail.tabs', contractVersion: 1, element: 'slot-demo-tab' },
    ]);

    const result = checkExtensionCompatibility(manifest, hostWithWebSdk({ slots: {} }));

    expect(result.compatible).toBe(false);
    expect(result.reasons).toContain('unsupported slot device.detail.tabs@1');
  });

  it('accepts device.detail.tabs@1 against the real (now-populated) HOST_DESCRIPTOR slots', () => {
    const manifest = makeSlotManifest([
      { slot: 'device.detail.tabs', contractVersion: 1, element: 'slot-demo-tab' },
    ]);

    expect(checkExtensionCompatibility(manifest, hostWithWebSdk()))
      .toEqual({ compatible: true, reasons: [] });
  });

  it('accepts organization.settings.sections@1 against the real HOST_DESCRIPTOR slots', () => {
    const manifest = makeSlotManifest([
      { slot: 'organization.settings.sections', contractVersion: 1, element: 'slot-demo-section' },
    ]);

    expect(checkExtensionCompatibility(manifest, hostWithWebSdk()))
      .toEqual({ compatible: true, reasons: [] });
  });

  it('rejects device.detail.tabs@2 against the real HOST_DESCRIPTOR slots', () => {
    const manifest = makeSlotManifest([
      { slot: 'device.detail.tabs', contractVersion: 2, element: 'slot-demo-tab' },
    ]);

    const result = checkExtensionCompatibility(manifest, hostWithWebSdk());

    expect(result.compatible).toBe(false);
    expect(result.reasons).toContain('unsupported slot device.detail.tabs@2');
  });

  it('rejects an unknown slot name against the real HOST_DESCRIPTOR slots', () => {
    const manifest = makeSlotManifest([
      { slot: 'some.unknown.slot', contractVersion: 1, element: 'slot-demo-tab' },
    ]);

    const result = checkExtensionCompatibility(manifest, hostWithWebSdk());

    expect(result.compatible).toBe(false);
    expect(result.reasons).toContain('unsupported slot some.unknown.slot@1');
  });
});
