import { describe, expect, it } from 'vitest';
import {
  PLATFORM_TRUST_MACOS,
  PLATFORM_TRUST_NONE,
  PLATFORM_TRUST_WINDOWS,
  PLATFORM_TRUST_WORKFLOW,
  assertDistributableReleaseAsset,
  assertGithubFetchableEdition,
  isSigningInputAssetName,
  requiredPlatformTrustFor,
} from './releaseAssetTrust';

describe('releaseAssetTrust', () => {
  it.each([
    ['breeze-agent-windows-amd64-unsigned.exe', true],
    ['breeze-agent-darwin-arm64-unsigned', true],
    ['breeze-user-helper-windows-amd64-unsigned.exe', true],
    ['breeze-agent-windows-amd64.exe', false],
    ['breeze-agent.msi', false],
    ['breeze-agent-darwin-arm64', false],
  ])('isSigningInputAssetName(%s) === %s', (name, expected) => {
    expect(isSigningInputAssetName(name)).toBe(expected);
  });

  it.each([
    ['breeze-agent-windows-amd64.exe', PLATFORM_TRUST_WINDOWS],
    ['breeze-agent.msi', PLATFORM_TRUST_WINDOWS],
    ['breeze-viewer-windows.msi', PLATFORM_TRUST_WINDOWS],
    ['breeze-agent-darwin-arm64.pkg', PLATFORM_TRUST_MACOS],
    ['breeze-helper-macos.dmg', PLATFORM_TRUST_MACOS],
    ['Breeze Installer.app.zip', PLATFORM_TRUST_MACOS],
    ['Breeze.Installer.app.zip', PLATFORM_TRUST_MACOS],
    ['breeze-agent-darwin-amd64', PLATFORM_TRUST_MACOS],
    ['breeze-watchdog-darwin-arm64', PLATFORM_TRUST_MACOS],
    ['breeze-agent-linux-amd64', null],
    ['install.sh', null],
  ])('requiredPlatformTrustFor(%s) === %s', (name, expected) => {
    expect(requiredPlatformTrustFor(name)).toBe(expected);
  });

  it('rejects signing-input intendedUse regardless of trust value', () => {
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-windows-amd64-unsigned.exe',
        platformTrust: 'none',
        intendedUse: 'signing-input',
      }),
    ).toThrow(/not distributable/);
  });

  it('rejects ANY non-null intendedUse (unknown values fail closed)', () => {
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-linux-amd64',
        platformTrust: PLATFORM_TRUST_WORKFLOW,
        intendedUse: 'debugging-symbols',
      }),
    ).toThrow(/not distributable/);
  });

  it('rejects -unsigned names even when the manifest entry claims full trust', () => {
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-windows-amd64-unsigned.exe',
        platformTrust: PLATFORM_TRUST_WINDOWS,
        intendedUse: null,
      }),
    ).toThrow(/signing input/);
  });

  it('rejects unknown platformTrust values', () => {
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-linux-amd64',
        platformTrust: 'totally-new-trust-level',
        intendedUse: null,
      }),
    ).toThrow(/unknown platformTrust/);
  });

  it('requires windows-authenticode-required on canonical Windows executables', () => {
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-windows-amd64.exe',
        platformTrust: PLATFORM_TRUST_WORKFLOW,
        intendedUse: null,
      }),
    ).toThrow(/windows-authenticode-required/);
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-windows-amd64.exe',
        platformTrust: null,
        intendedUse: null,
      }),
    ).toThrow(/windows-authenticode-required/);
  });

  it('requires macos-developer-id-notarization-required on canonical macOS assets', () => {
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-darwin-arm64.pkg',
        platformTrust: PLATFORM_TRUST_WORKFLOW,
        intendedUse: null,
      }),
    ).toThrow(/macos-developer-id-notarization-required/);
  });

  it('accepts a correctly-labeled canonical asset and a plain linux asset', () => {
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-windows-amd64.exe',
        platformTrust: PLATFORM_TRUST_WINDOWS,
        intendedUse: null,
      }),
    ).not.toThrow();
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-linux-amd64',
        platformTrust: PLATFORM_TRUST_WORKFLOW,
        intendedUse: null,
      }),
    ).not.toThrow();
    // Pre-platformTrust manifests: null on a non-canonical asset is tolerated.
    expect(() =>
      assertDistributableReleaseAsset({
        assetName: 'breeze-agent-linux-amd64',
        platformTrust: null,
        intendedUse: null,
      }),
    ).not.toThrow();
  });

  describe('edition-aware MSI acceptance', () => {
    it('accepts an unsigned self-host breeze-agent.msi', () => {
      expect(() =>
        assertDistributableReleaseAsset({
          assetName: 'breeze-agent.msi',
          platformTrust: PLATFORM_TRUST_NONE,
          intendedUse: null,
          edition: 'self-host',
        }),
      ).not.toThrow();
    });

    it('still accepts a signed self-host breeze-agent.msi (BYO-resigned repos)', () => {
      expect(() =>
        assertDistributableReleaseAsset({
          assetName: 'breeze-agent.msi',
          platformTrust: PLATFORM_TRUST_WINDOWS,
          intendedUse: null,
          edition: 'self-host',
        }),
      ).not.toThrow();
    });

    it('rejects an unsigned breeze-agent.msi with no edition claim (today\'s behavior unchanged)', () => {
      expect(() =>
        assertDistributableReleaseAsset({
          assetName: 'breeze-agent.msi',
          platformTrust: PLATFORM_TRUST_NONE,
          intendedUse: null,
        }),
      ).toThrow(/windows-authenticode-required/);
    });

    it('rejects an unsigned breeze-agent.msi labeled edition "hosted"', () => {
      expect(() =>
        assertDistributableReleaseAsset({
          assetName: 'breeze-agent.msi',
          platformTrust: PLATFORM_TRUST_NONE,
          intendedUse: null,
          edition: 'hosted',
        }),
      ).toThrow(/windows-authenticode-required/);
    });

    it('does NOT extend the unsigned exception to other .msi assets (e.g. helper)', () => {
      expect(() =>
        assertDistributableReleaseAsset({
          assetName: 'breeze-helper-windows.msi',
          platformTrust: PLATFORM_TRUST_NONE,
          intendedUse: null,
          edition: 'self-host',
        }),
      ).toThrow(/windows-authenticode-required/);
    });

    it('rejects an unknown edition value (fails closed)', () => {
      expect(() =>
        assertDistributableReleaseAsset({
          assetName: 'breeze-agent-linux-amd64',
          platformTrust: PLATFORM_TRUST_WORKFLOW,
          intendedUse: null,
          edition: 'enterprise',
        }),
      ).toThrow(/unknown edition/);
    });

    it('tolerates edition undefined/null identically (manifests predating the field)', () => {
      expect(() =>
        assertDistributableReleaseAsset({
          assetName: 'breeze-agent-linux-amd64',
          platformTrust: PLATFORM_TRUST_WORKFLOW,
          intendedUse: null,
          edition: null,
        }),
      ).not.toThrow();
      expect(() =>
        assertDistributableReleaseAsset({
          assetName: 'breeze-agent-linux-amd64',
          platformTrust: PLATFORM_TRUST_WORKFLOW,
          intendedUse: null,
        }),
      ).not.toThrow();
    });
  });

  describe('assertGithubFetchableEdition', () => {
    it('refuses an asset labeled edition "hosted"', () => {
      expect(() =>
        assertGithubFetchableEdition({ assetName: 'breeze-agent.msi', edition: 'hosted' }),
      ).toThrow(/must never be fetched from a public GitHub release/);
    });

    it('allows edition "self-host"', () => {
      expect(() =>
        assertGithubFetchableEdition({ assetName: 'breeze-agent.msi', edition: 'self-host' }),
      ).not.toThrow();
    });

    it('allows a null/absent edition (manifests predating the field)', () => {
      expect(() =>
        assertGithubFetchableEdition({ assetName: 'breeze-agent.msi', edition: null }),
      ).not.toThrow();
    });
  });
});
