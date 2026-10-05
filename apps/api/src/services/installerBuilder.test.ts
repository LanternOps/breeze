import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import JSZip from 'jszip';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  buildMacosInstallerZip,
  buildWindowsInstallerZip,
  fetchRegularMsi,
  fetchVerifiedMacosPkg,
  fetchMacosInstallerAppZip,
  fetchVerifiedHelperInstaller,
  __resetVerifiedMacosPkgCache,
  __resetVerifiedHelperInstallerCache,
  __resetRegularMsiCache,
  startRegularMsiCacheWarmer,
  __stopRegularMsiCacheWarmer,
  assertMacosInstallerPkgsReachable,
  serveWindowsBootstrapMsi,
} from './installerBuilder';
import { HELPER_FILENAMES } from './binarySource';
import type { Context } from 'hono';
import * as s3Storage from './s3Storage';
import { ReleaseManifestTooOldError } from './releaseArtifactManifest';

// `fetchRegularMsi` pulls the release artifact manifest + signature through
// `releaseArtifactManifest.fetchSmallBuffer`, which moved off global `fetch` onto
// the SSRF-guarded `safeFetchFollowingRedirects` (#3649). That helper dials
// Node's http/https directly so it is pinned per hop, which means the
// `vi.stubGlobal('fetch', ...)` harness below no longer intercepts it — these
// tests silently began making REAL requests to github.com and failing on a 404.
// Routing the guarded helper back through the global stub keeps every existing
// case intercepted and unchanged. Guard behaviour itself is covered for real
// (socket-level, unmocked) in releaseArtifactManifest.redirect.test.ts.
const { safeFetchFollowingRedirectsMock } = vi.hoisted(() => ({
  safeFetchFollowingRedirectsMock: vi.fn((url: string) => globalThis.fetch(url)),
}));

vi.mock('./urlSafety', () => ({
  safeFetchFollowingRedirects: safeFetchFollowingRedirectsMock,
}));

// Real keys are 64 lowercase hex chars produced by randomBytes(32).toString('hex').
// Tests use that exact generator so a future drift between generator and validator
// fails here loudly.
function realEnrollmentKey(): string {
  return randomBytes(32).toString('hex');
}

function signedReleaseManifest(
  assetName: string,
  assetBuffer: Buffer,
  assetOverrides: Record<string, unknown> = {},
  manifestOverrides: Record<string, unknown> = {},
) {
  return signedReleaseManifestEntries([
    {
      name: assetName,
      sha256: createHash('sha256').update(assetBuffer).digest('hex'),
      size: assetBuffer.length,
      platformTrust: 'windows-authenticode-required',
      ...assetOverrides,
    },
  ], manifestOverrides);
}

function signedReleaseManifestEntries(
  assets: Record<string, unknown>[],
  manifestOverrides: Record<string, unknown> = {},
) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const rawPublicKey = publicDer.subarray(publicDer.length - 32).toString('base64');
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    repository: 'lanternops/breeze',
    release: 'v1.2.3',
    assets,
    ...manifestOverrides,
  }));

  return {
    manifest,
    signature: Buffer.from(sign(null, manifest, privateKey).toString('base64')),
    publicKey: rawPublicKey,
  };
}

describe('fetchRegularMsi', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // mockClear, not mockReset: the forwarding implementation must survive.
    safeFetchFollowingRedirectsMock.mockClear();
    __resetVerifiedMacosPkgCache();
    __resetRegularMsiCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetVerifiedMacosPkgCache();
    __resetRegularMsiCache();
  });

  it('verifies GitHub release MSI bytes against the signed release artifact manifest', async () => {
    const asset = Buffer.from('signed-msi');
    const signed = signedReleaseManifest('breeze-agent.msi', asset);
    process.env.BINARY_SOURCE = 'github';
    process.env.BINARY_VERSION = '1.2.3';
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/breeze-agent.msi')) return new Response(asset);
      if (url.endsWith('/release-artifact-manifest.json')) return new Response(signed.manifest);
      if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(signed.signature);
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchRegularMsi()).resolves.toEqual(asset);
    // Previously this pinned `{ redirect: 'follow' }` on the global fetch. That
    // argument is exactly what #3649 removed, so the assertion now pins the
    // stronger property: the signature is fetched through the SSRF-guarded
    // helper, under the manifest byte ceiling.
    expect(safeFetchFollowingRedirectsMock).toHaveBeenCalledWith(
      'https://github.com/lanternops/breeze/releases/download/v1.2.3/release-artifact-manifest.json.ed25519',
      { maxBytes: 1024 * 1024 },
    );
  });

  it('server-only image: fetches and verifies the MSI against the paired binaries release', async () => {
    const asset = Buffer.from('signed-msi');
    const signed = signedReleaseManifest('breeze-agent.msi', asset, {}, { release: 'v0.118.0' });
    process.env.BINARY_SOURCE = 'github';
    delete process.env.BINARY_VERSION;
    process.env.BREEZE_VERSION = '0.118.2';
    process.env.BREEZE_BINARIES_VERSION = '0.118.0';
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    const fetchMock = vi.fn(async (url: string) => {
      if (!url.includes('/releases/download/v0.118.0/')) return new Response('wrong release', { status: 404 });
      if (url.endsWith('/breeze-agent.msi')) return new Response(asset);
      if (url.endsWith('/release-artifact-manifest.json')) return new Response(signed.manifest);
      if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(signed.signature);
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Expected release tag v0.118.0 (the manifest's), not the server's v0.118.2.
    await expect(fetchRegularMsi()).resolves.toEqual(asset);
    for (const [url] of fetchMock.mock.calls) expect(String(url)).not.toContain('0.118.2');
  });

  it('accepts an unsigned MSI labeled edition self-host', async () => {
    const asset = Buffer.from('unsigned-self-host-msi');
    const signed = signedReleaseManifest('breeze-agent.msi', asset, {
      platformTrust: 'none',
      edition: 'self-host',
    });
    process.env.BINARY_SOURCE = 'github';
    process.env.BINARY_VERSION = '1.2.3';
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/breeze-agent.msi')) return new Response(asset);
      if (url.endsWith('/release-artifact-manifest.json')) return new Response(signed.manifest);
      if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(signed.signature);
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchRegularMsi()).resolves.toEqual(asset);
  });

  it('rejects an unsigned MSI with no edition claim (today\'s behavior unchanged)', async () => {
    const asset = Buffer.from('unsigned-no-edition-msi');
    const signed = signedReleaseManifest('breeze-agent.msi', asset, {
      platformTrust: 'none',
    });
    process.env.BINARY_SOURCE = 'github';
    process.env.BINARY_VERSION = '1.2.3';
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/breeze-agent.msi')) return new Response(asset);
      if (url.endsWith('/release-artifact-manifest.json')) return new Response(signed.manifest);
      if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(signed.signature);
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchRegularMsi()).rejects.toThrow(/windows-authenticode-required/);
  });

  it('refuses an MSI labeled edition hosted, even if properly signed', async () => {
    const asset = Buffer.from('hosted-signed-msi');
    const signed = signedReleaseManifest('breeze-agent.msi', asset, {
      platformTrust: 'windows-authenticode-required',
      edition: 'hosted',
    });
    process.env.BINARY_SOURCE = 'github';
    process.env.BINARY_VERSION = '1.2.3';
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/breeze-agent.msi')) return new Response(asset);
      if (url.endsWith('/release-artifact-manifest.json')) return new Response(signed.manifest);
      if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(signed.signature);
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchRegularMsi()).rejects.toThrow(/must never be fetched from a public GitHub release/);
  });

  it('rejects an unsigned MSI labeled edition hosted', async () => {
    const asset = Buffer.from('unsigned-hosted-msi');
    const signed = signedReleaseManifest('breeze-agent.msi', asset, {
      platformTrust: 'none',
      edition: 'hosted',
    });
    process.env.BINARY_SOURCE = 'github';
    process.env.BINARY_VERSION = '1.2.3';
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/breeze-agent.msi')) return new Response(asset);
      if (url.endsWith('/release-artifact-manifest.json')) return new Response(signed.manifest);
      if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(signed.signature);
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Both violations apply (unsigned + hosted); the baseline trust check
    // fires first.
    await expect(fetchRegularMsi()).rejects.toThrow(/windows-authenticode-required/);
  });

  // The installer routes that call fetchRegularMsi() all run under a held
  // ambient DB transaction — a slow/cold fetch on every request pins a
  // pooled connection idle-in-transaction for as long as GitHub takes.
  // Caching the verified buffer means only the first request in the TTL
  // window pays that cost.
  it('caches the verified buffer so a second call does not refetch', async () => {
    const asset = Buffer.from('cached-msi');
    const signed = signedReleaseManifest('breeze-agent.msi', asset);
    process.env.BINARY_SOURCE = 'github';
    process.env.BINARY_VERSION = '1.2.3';
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/breeze-agent.msi')) return new Response(asset);
      if (url.endsWith('/release-artifact-manifest.json')) return new Response(signed.manifest);
      if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(signed.signature);
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchRegularMsi()).resolves.toEqual(asset);
    const msiCallsAfterFirst = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/breeze-agent.msi'),
    ).length;
    expect(msiCallsAfterFirst).toBe(1);

    await expect(fetchRegularMsi()).resolves.toEqual(asset);
    const msiCallsAfterSecond = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/breeze-agent.msi'),
    ).length;
    // A cache hit must not issue a second network fetch for the MSI.
    expect(msiCallsAfterSecond).toBe(1);
  });

  it('does not cache a failed fetch (a transient GitHub failure must not stick)', async () => {
    process.env.BINARY_SOURCE = 'github';
    process.env.BINARY_VERSION = '1.2.3';
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = 'irrelevant-for-this-test';

    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(fetchRegularMsi()).rejects.toThrow(/Failed to fetch regular MSI/);

    // A subsequent call must retry, not replay the cached rejection.
    const asset = Buffer.from('recovered-msi');
    const signed = signedReleaseManifest('breeze-agent.msi', asset);
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/breeze-agent.msi')) return new Response(asset);
      if (url.endsWith('/release-artifact-manifest.json')) return new Response(signed.manifest);
      if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(signed.signature);
      return new Response('not found', { status: 404 });
    }));
    await expect(fetchRegularMsi()).resolves.toEqual(asset);
  });

  it('passes a bounded abort signal so a hung origin cannot hold the fetch open indefinitely', async () => {
    process.env.BINARY_SOURCE = 'github';
    process.env.BINARY_VERSION = '1.2.3';
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = 'irrelevant-for-this-test';

    const fetchMock = vi.fn(async () => new Response('unused'));
    vi.stubGlobal('fetch', fetchMock);

    await fetchRegularMsi().catch(() => undefined);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('breeze-agent.msi'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe('startRegularMsiCacheWarmer', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    safeFetchFollowingRedirectsMock.mockClear();
    __resetVerifiedMacosPkgCache();
    __resetRegularMsiCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    __stopRegularMsiCacheWarmer();
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    __resetVerifiedMacosPkgCache();
    __resetRegularMsiCache();
  });

  // Request handlers run inside an ambient DB transaction opened by auth
  // middleware before the route handler runs — there is no "before the
  // handler opens its DB context" point available to a single-flight fetch
  // for that authenticated route. A background warmer keeps the cache hot
  // independent of request traffic so a request almost always finds a warm
  // cache instead of paying the network round trip while holding a pooled
  // connection.
  it('populates the cache immediately on start, without waiting for a request', async () => {
    const asset = Buffer.from('warmed-msi');
    const signed = signedReleaseManifest('breeze-agent.msi', asset);
    process.env.BINARY_SOURCE = 'github';
    process.env.BINARY_VERSION = '1.2.3';
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/breeze-agent.msi')) return new Response(asset);
      if (url.endsWith('/release-artifact-manifest.json')) return new Response(signed.manifest);
      if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(signed.signature);
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    startRegularMsiCacheWarmer();
    // startRegularMsiCacheWarmer's immediate warm populates fetchRegularMsi's
    // single-flight cache synchronously — a request arriving now shares that
    // SAME in-flight promise rather than issuing its own fetch.
    await expect(fetchRegularMsi()).resolves.toEqual(asset);

    const msiCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/breeze-agent.msi')).length;
    expect(msiCalls).toBe(1);
  });

  it('refreshes on an interval before the cache entry would expire', async () => {
    const asset = Buffer.from('warmed-msi-2');
    const signed = signedReleaseManifest('breeze-agent.msi', asset);
    process.env.BINARY_SOURCE = 'github';
    process.env.BINARY_VERSION = '1.2.3';
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/breeze-agent.msi')) return new Response(asset);
      if (url.endsWith('/release-artifact-manifest.json')) return new Response(signed.manifest);
      if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(signed.signature);
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    startRegularMsiCacheWarmer();
    await fetchRegularMsi();
    const firstRoundCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/breeze-agent.msi')).length;
    expect(firstRoundCalls).toBe(1);

    // Advance past a full 5-minute cache TTL — a background refresh must have
    // fired well before the entry would have gone stale.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    const secondRoundCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/breeze-agent.msi')).length;
    expect(secondRoundCalls).toBeGreaterThan(firstRoundCalls);
  });

  it('is idempotent — calling it twice does not double the refresh rate', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    startRegularMsiCacheWarmer();
    startRegularMsiCacheWarmer();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows a background fetch failure instead of throwing (must never crash the process)', async () => {
    process.env.BINARY_SOURCE = 'github';
    process.env.BINARY_VERSION = '1.2.3';
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = 'irrelevant-for-this-test';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));

    expect(() => startRegularMsiCacheWarmer()).not.toThrow();
    // fetchRegularMsi() shares the same single-flight promise the warmer
    // kicked off — awaiting (and swallowing) its rejection here proves the
    // warmer's own .catch() already observed it without an unhandled
    // rejection or a thrown error.
    await expect(fetchRegularMsi()).rejects.toThrow();
  });
});

describe('fetchVerifiedMacosPkg', () => {
  const originalEnv = process.env;
  const identity = 'Developer ID Installer: LanternOps LLC (D8W6N2JYMA)';

  beforeEach(() => {
    process.env = { ...originalEnv };
    safeFetchFollowingRedirectsMock.mockClear();
    __resetVerifiedMacosPkgCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    __resetVerifiedMacosPkgCache();
  });

  it.each(['amd64', 'arm64'] as const)(
    'serves only %s pkg bytes authorized by the signed release manifest',
    async (arch) => {
      const assetName = `breeze-agent-darwin-${arch}.pkg`;
      const asset = Buffer.from(`signed-pkg-${arch}`);
      const signed = signedReleaseManifest(assetName, asset, {
        platformTrust: 'macos-developer-id-notarization-required',
        edition: 'self-host',
        signingIdentity: identity,
        signingTeamId: 'D8W6N2JYMA',
      });
      process.env.BINARY_SOURCE = 'github';
      process.env.BINARY_VERSION = '1.2.3';
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.endsWith(`/${assetName}`)) return new Response(asset);
        if (url.endsWith('/release-artifact-manifest.json')) return new Response(signed.manifest);
        if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(signed.signature);
        return new Response('not found', { status: 404 });
      }));

      const result = await fetchVerifiedMacosPkg(arch);
      expect(result.buffer).toEqual(asset);
      expect(result.artifact).toMatchObject({
        assetName,
        release: 'v1.2.3',
        signingIdentity: identity,
        signingTeamId: 'D8W6N2JYMA',
      });
    },
  );

  it('rejects same-size substituted pkg bytes before serving them', async () => {
    const assetName = 'breeze-agent-darwin-arm64.pkg';
    const authorized = Buffer.from('authorized-pkg');
    const substituted = Buffer.from('substitute-pkg');
    const signed = signedReleaseManifest(assetName, authorized, {
      platformTrust: 'macos-developer-id-notarization-required',
      edition: 'self-host',
      signingIdentity: identity,
      signingTeamId: 'D8W6N2JYMA',
    });
    process.env.BINARY_SOURCE = 'github';
    process.env.BINARY_VERSION = '1.2.3';
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith(`/${assetName}`)) return new Response(substituted);
      if (url.endsWith('/release-artifact-manifest.json')) return new Response(signed.manifest);
      if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(signed.signature);
      return new Response('not found', { status: 404 });
    }));

    await expect(fetchVerifiedMacosPkg('arm64')).rejects.toThrow(/digest mismatch/);
  });

  it('rejects a validly signed manifest that omits the exact macOS publisher', async () => {
    const assetName = 'breeze-agent-darwin-amd64.pkg';
    const asset = Buffer.from('signed-pkg');
    const signed = signedReleaseManifest(assetName, asset, {
      platformTrust: 'macos-developer-id-notarization-required',
      edition: 'self-host',
    });
    process.env.BINARY_SOURCE = 'github';
    process.env.BINARY_VERSION = '1.2.3';
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith(`/${assetName}`)) return new Response(asset);
      if (url.endsWith('/release-artifact-manifest.json')) return new Response(signed.manifest);
      if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(signed.signature);
      return new Response('not found', { status: 404 });
    }));

    await expect(fetchVerifiedMacosPkg('amd64')).rejects.toThrow(/macOS signing identity/);
  });

  it('local mode verifies the exact staged pkg against the signed root manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'breeze-local-pkg-'));
    const binaryDir = join(root, 'agent');
    const assetName = 'breeze-agent-darwin-arm64.pkg';
    const asset = Buffer.from('local-signed-pkg');
    const signed = signedReleaseManifest(assetName, asset, {
      platformTrust: 'macos-developer-id-notarization-required',
      edition: 'self-host',
      signingIdentity: identity,
      signingTeamId: 'D8W6N2JYMA',
    });
    try {
      mkdirSync(binaryDir);
      writeFileSync(join(binaryDir, assetName), asset);
      writeFileSync(join(root, 'release-artifact-manifest.json'), signed.manifest);
      writeFileSync(join(root, 'release-artifact-manifest.json.ed25519'), signed.signature);
      process.env.BINARY_SOURCE = 'local';
      process.env.BINARY_VERSION = '1.2.3';
      process.env.BINARY_EDITION = 'self-host';
      process.env.AGENT_BINARY_DIR = binaryDir;
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
      delete process.env.S3_BUCKET;
      delete process.env.S3_ACCESS_KEY;
      delete process.env.S3_SECRET_KEY;

      await expect(fetchVerifiedMacosPkg('arm64')).resolves.toMatchObject({ buffer: asset });
      writeFileSync(join(binaryDir, assetName), Buffer.from('local-evil-pkg!!'));
      __resetVerifiedMacosPkgCache();
      await expect(fetchVerifiedMacosPkg('arm64')).rejects.toThrow(/digest mismatch/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('local mode verifies the Helper installer when HELPER_BINARY_DIR differs from AGENT_BINARY_DIR', async () => {
    // Self-hosters may point the Helper installer's own directory somewhere
    // other than the agent/MSI binaries (HELPER_BINARY_DIR predates this
    // fetch path specifically to support that split). The signed manifest
    // pair must be looked up next to the asset it verifies — HELPER_BINARY_DIR
    // for the Helper — never hardcoded to AGENT_BINARY_DIR.
    // The manifest pair is staged in the PARENT of the binary directory
    // (localReleaseManifestPaths: `dirname(resolve(binaryDir))`), so
    // AGENT_BINARY_DIR and HELPER_BINARY_DIR must have DIFFERENT parents too
    // — otherwise a lookup keyed off the wrong env var would still stumble
    // onto the right manifest by accident and this test would not discriminate.
    const root = mkdtempSync(join(tmpdir(), 'breeze-local-helper-split-'));
    const agentDir = join(root, 'agent-root', 'agent');
    const helperDir = join(root, 'helper-root', 'helper');
    const os = 'windows';
    const assetName = HELPER_FILENAMES[os]!;
    const asset = Buffer.from('local-signed-helper-installer');
    const signed = signedReleaseManifest(assetName, asset, {
      platformTrust: 'windows-authenticode-required',
      edition: 'self-host',
    });
    try {
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(helperDir, { recursive: true });
      // The manifest pair and the asset both live under HELPER_BINARY_DIR's
      // tree — the "natural place" a self-hoster stages them (per the
      // finding). AGENT_BINARY_DIR's tree stays real but manifest-less:
      // staging the manifest there too would defeat this test.
      writeFileSync(join(helperDir, assetName), asset);
      writeFileSync(join(root, 'helper-root', 'release-artifact-manifest.json'), signed.manifest);
      writeFileSync(join(root, 'helper-root', 'release-artifact-manifest.json.ed25519'), signed.signature);
      process.env = {
        ...originalEnv,
        BINARY_SOURCE: 'local',
        BINARY_VERSION: '1.2.3',
        BINARY_EDITION: 'self-host',
        AGENT_BINARY_DIR: agentDir,
        HELPER_BINARY_DIR: helperDir,
        RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: signed.publicKey,
      };
      delete process.env.S3_BUCKET;
      delete process.env.S3_ACCESS_KEY;
      delete process.env.S3_SECRET_KEY;

      __resetVerifiedHelperInstallerCache();
      await expect(fetchVerifiedHelperInstaller(os)).resolves.toMatchObject({ buffer: asset });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('S3 mode reads and verifies bytes server-side without a presigned redirect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'breeze-s3-pkg-'));
    const binaryDir = join(root, 'agent');
    const assetName = 'breeze-agent-darwin-arm64.pkg';
    const asset = Buffer.from('synthetic-s3-pkg');
    const signed = signedReleaseManifest(assetName, asset, {
      platformTrust: 'macos-developer-id-notarization-required',
      edition: 'self-host',
      signingIdentity: identity,
      signingTeamId: 'D8W6N2JYMA',
    });
    try {
      mkdirSync(binaryDir);
      writeFileSync(join(root, 'release-artifact-manifest.json'), signed.manifest);
      writeFileSync(join(root, 'release-artifact-manifest.json.ed25519'), signed.signature);
      process.env = {
        ...originalEnv,
        BINARY_SOURCE: 'local', BINARY_VERSION: '1.2.3', BINARY_EDITION: 'self-host',
        AGENT_BINARY_DIR: binaryDir,
        RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: signed.publicKey,
        S3_BUCKET: 'synthetic', S3_ACCESS_KEY: 'synthetic', S3_SECRET_KEY: 'synthetic',
      };
      const getObject = vi.spyOn(s3Storage, 'getObjectStream').mockResolvedValue({
        body: Readable.from([asset]),
        contentLength: asset.length,
      });

      await expect(fetchVerifiedMacosPkg('arm64')).resolves.toMatchObject({ buffer: asset });
      expect(getObject).toHaveBeenCalledWith(`agent/${assetName}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('S3 mode rejects an object whose length differs from the signed size', async () => {
    const root = mkdtempSync(join(tmpdir(), 'breeze-s3-size-'));
    const binaryDir = join(root, 'agent');
    const assetName = 'breeze-agent-darwin-arm64.pkg';
    const asset = Buffer.from('synthetic-s3-pkg');
    const signed = signedReleaseManifest(assetName, asset, {
      platformTrust: 'macos-developer-id-notarization-required', edition: 'self-host',
      signingIdentity: identity, signingTeamId: 'D8W6N2JYMA',
    });
    try {
      mkdirSync(binaryDir);
      writeFileSync(join(root, 'release-artifact-manifest.json'), signed.manifest);
      writeFileSync(join(root, 'release-artifact-manifest.json.ed25519'), signed.signature);
      process.env = {
        ...originalEnv,
        BINARY_SOURCE: 'local', BINARY_VERSION: '1.2.3', BINARY_EDITION: 'self-host',
        AGENT_BINARY_DIR: binaryDir,
        RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: signed.publicKey,
        S3_BUCKET: 'synthetic', S3_ACCESS_KEY: 'synthetic', S3_SECRET_KEY: 'synthetic',
      };
      const substituted = Buffer.concat([asset, Buffer.from('x')]);
      vi.spyOn(s3Storage, 'getObjectStream').mockResolvedValue({
        body: Readable.from([substituted]), contentLength: substituted.length,
      });
      await expect(fetchVerifiedMacosPkg('arm64')).rejects.toThrow(/content length/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// A hosted install runs BINARY_SOURCE=local with a binaries volume populated
// from a separately built and signed hosted release. That volume's manifest
// is the hosted build's manifest, so its `repository` (and release tag) are
// NOT the public GitHub repository. For the local source the trust anchor is
// the manifest's Ed25519 signature against the configured keys — the same
// contract binarySync applies when registering agent binaries from the local
// manifest — plus the per-asset entry, size/sha256 and edition checks. The
// repository/release pins belong to the GitHub source only.
describe('local source: hosted build manifest', () => {
  const originalEnv = process.env;
  const identity = 'Developer ID Installer: LanternOps LLC (D8W6N2JYMA)';
  const hostedManifest = { repository: 'example-org/hosted-build', release: 'v9.9.9-hosted' };
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'breeze-local-hosted-'));
    __resetVerifiedMacosPkgCache();
    __resetVerifiedHelperInstallerCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    __resetVerifiedMacosPkgCache();
    __resetVerifiedHelperInstallerCache();
    rmSync(root, { recursive: true, force: true });
  });

  function stage(args: {
    assetName: string;
    servedBytes: Buffer;
    signed: { manifest: Buffer; signature: Buffer; publicKey: string };
    trustedPublicKey?: string;
    edition?: string;
  }) {
    const binaryDir = join(root, 'bin');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, args.assetName), args.servedBytes);
    writeFileSync(join(root, 'release-artifact-manifest.json'), args.signed.manifest);
    writeFileSync(join(root, 'release-artifact-manifest.json.ed25519'), args.signed.signature);
    process.env = {
      ...originalEnv,
      BINARY_SOURCE: 'local',
      BINARY_VERSION: '1.2.3',
      BINARY_EDITION: args.edition ?? 'hosted',
      AGENT_BINARY_DIR: binaryDir,
      HELPER_BINARY_DIR: binaryDir,
      RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: args.trustedPublicKey ?? args.signed.publicKey,
    };
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY;
    delete process.env.S3_SECRET_KEY;
  }

  const macosPkg = {
    label: 'macOS pkg',
    assetName: 'breeze-agent-darwin-arm64.pkg',
    entry: {
      platformTrust: 'macos-developer-id-notarization-required',
      edition: 'hosted',
      signingIdentity: identity,
      signingTeamId: 'D8W6N2JYMA',
    },
    fetch: () => fetchVerifiedMacosPkg('arm64'),
  };

  // The Helper installer is NOT an agent-family asset: it is built only by the
  // public release and is edition-neutral, so it never verifies against this
  // root (hosted) manifest — see 'local source: Helper installer manifest'.
  describe.each([macosPkg])('$label', (target) => {
    it('serves an asset from a correctly signed manifest whose repository is not the public repository', async () => {
      const asset = Buffer.from(`hosted-${target.assetName}`);
      const signed = signedReleaseManifest(target.assetName, asset, target.entry, hostedManifest);
      stage({ assetName: target.assetName, servedBytes: asset, signed });

      const result = await target.fetch();
      expect(result.buffer).toEqual(asset);
      expect(result.artifact).toMatchObject({
        assetName: target.assetName,
        repository: hostedManifest.repository,
        edition: 'hosted',
      });
    });

    it('refuses a manifest signed by a key that is not trusted', async () => {
      const asset = Buffer.from(`hosted-${target.assetName}`);
      const signed = signedReleaseManifest(target.assetName, asset, target.entry, hostedManifest);
      const untrusted = signedReleaseManifest(target.assetName, asset, target.entry, hostedManifest);
      stage({
        assetName: target.assetName,
        servedBytes: asset,
        signed,
        trustedPublicKey: untrusted.publicKey,
      });

      await expect(target.fetch()).rejects.toThrow(/signature/i);
    });

    it('refuses an asset whose manifest edition differs from BINARY_EDITION', async () => {
      const asset = Buffer.from(`hosted-${target.assetName}`);
      const signed = signedReleaseManifest(
        target.assetName,
        asset,
        { ...target.entry, edition: 'self-host' },
        hostedManifest,
      );
      stage({ assetName: target.assetName, servedBytes: asset, signed });

      await expect(target.fetch()).rejects.toThrow(/edition mismatch/);
    });

    it('refuses same-size bytes whose sha256 differs from the signed entry', async () => {
      const authorized = Buffer.from(`hosted-${target.assetName}`);
      const substituted = Buffer.from(authorized.toString('utf8').replace('hosted', 'evil!!'));
      expect(substituted.length).toBe(authorized.length);
      const signed = signedReleaseManifest(target.assetName, authorized, target.entry, hostedManifest);
      stage({ assetName: target.assetName, servedBytes: substituted, signed });

      await expect(target.fetch()).rejects.toThrow(/digest mismatch/);
    });
  });
});

// The Breeze Assist (Helper) installers are built ONLY by the public release
// and are byte-identical for both editions; the public release manifest lists
// them with `edition: "self-host"`. A hosted binaries volume carries the
// hosted build's manifest at its root (agent family only, edition "hosted"),
// so the Helper must verify against the official release manifest pair staged
// in the Helper's OWN directory, with edition pinned to "self-host" whatever
// BINARY_EDITION says — and must never fall back to the hosted root manifest.
describe('local source: Helper installer manifest', () => {
  const originalEnv = process.env;
  const os = 'linux';
  const assetName = HELPER_FILENAMES[os]!;
  const officialRelease = { repository: 'lanternops/breeze', release: 'v1.2.3' };
  const hostedRelease = { repository: 'example-org/hosted-build', release: 'v1.2.3-hosted' };
  let root: string;
  let agentDir: string;
  let helperDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'breeze-local-helper-manifest-'));
    agentDir = join(root, 'agent');
    helperDir = join(root, 'helper');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(helperDir, { recursive: true });
    __resetVerifiedHelperInstallerCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    __resetVerifiedHelperInstallerCache();
    rmSync(root, { recursive: true, force: true });
  });

  function writePair(dir: string, signed: { manifest: Buffer; signature: Buffer }) {
    writeFileSync(join(dir, 'release-artifact-manifest.json'), signed.manifest);
    writeFileSync(join(dir, 'release-artifact-manifest.json.ed25519'), signed.signature);
  }

  function setEnv(edition: 'hosted' | 'self-host', trustedKeys: string[]) {
    process.env = {
      ...originalEnv,
      BINARY_SOURCE: 'local',
      BINARY_VERSION: '1.2.3',
      BINARY_EDITION: edition,
      AGENT_BINARY_DIR: agentDir,
      HELPER_BINARY_DIR: helperDir,
      RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: trustedKeys.join(','),
    };
    delete process.env.BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY;
    delete process.env.S3_SECRET_KEY;
  }

  // Hosted layout: hosted manifest at the volume root (agent family only),
  // official release manifest in helper/.
  function stageHosted(args: {
    servedBytes?: Buffer;
    official?: { manifest: Buffer; signature: Buffer; publicKey: string } | null;
    officialEntry?: Record<string, unknown>;
    hostedCoversHelper?: boolean;
    trustOfficialKey?: boolean;
  } = {}) {
    const asset = Buffer.from('official-helper-appimage');
    const official = args.official === undefined
      ? signedReleaseManifest(assetName, asset, {
        platformTrust: 'release-workflow-produced',
        edition: 'self-host',
        ...args.officialEntry,
      }, officialRelease)
      : args.official;
    const hostedAssets: Record<string, unknown>[] = [{
      name: 'breeze-agent-linux-amd64',
      sha256: createHash('sha256').update('agent').digest('hex'),
      size: 5,
      platformTrust: 'none',
      edition: 'hosted',
    }];
    if (args.hostedCoversHelper) {
      hostedAssets.push({
        name: assetName,
        sha256: createHash('sha256').update(args.servedBytes ?? asset).digest('hex'),
        size: (args.servedBytes ?? asset).length,
        platformTrust: 'release-workflow-produced',
        edition: 'self-host',
      });
    }
    const hosted = signedReleaseManifestEntries(hostedAssets, hostedRelease);
    writeFileSync(join(helperDir, assetName), args.servedBytes ?? asset);
    writePair(root, hosted);
    if (official) writePair(helperDir, official);
    const keys = [hosted.publicKey];
    if (official && args.trustOfficialKey !== false) keys.push(official.publicKey);
    setEnv('hosted', keys);
    return { asset, official, hosted };
  }

  describe('hosted layout (BINARY_EDITION=hosted)', () => {
    it('serves the Helper verified against the official manifest in its own directory', async () => {
      const { asset } = stageHosted();

      const result = await fetchVerifiedHelperInstaller(os);
      expect(result.buffer).toEqual(asset);
      expect(result.artifact).toMatchObject({
        assetName,
        repository: officialRelease.repository,
        edition: 'self-host',
      });
    });

    it('refuses when the Helper directory has no manifest pair, even if the hosted root manifest lists the asset', async () => {
      stageHosted({ official: null, hostedCoversHelper: true });

      await expect(fetchVerifiedHelperInstaller(os)).rejects.toThrow(/manifest pair is not staged/i);
    });

    it('refuses when only the manifest (no signature) is staged in the Helper directory', async () => {
      stageHosted();
      rmSync(join(helperDir, 'release-artifact-manifest.json.ed25519'));

      await expect(fetchVerifiedHelperInstaller(os)).rejects.toThrow(/manifest pair/i);
    });

    it('refuses a Helper entry whose edition is not self-host', async () => {
      stageHosted({ officialEntry: { edition: 'hosted' } });

      await expect(fetchVerifiedHelperInstaller(os)).rejects.toThrow(/edition mismatch/);
    });

    it('refuses a Helper entry with no edition claim', async () => {
      stageHosted({ officialEntry: { edition: undefined } });

      await expect(fetchVerifiedHelperInstaller(os)).rejects.toThrow(/edition mismatch/);
    });

    it('refuses same-size tampered bytes', async () => {
      const asset = Buffer.from('official-helper-appimage');
      const tampered = Buffer.from('official-helper-EVILimage');
      const official = signedReleaseManifest(assetName, asset, {
        platformTrust: 'release-workflow-produced',
        edition: 'self-host',
      }, officialRelease);
      stageHosted({ official, servedBytes: Buffer.from(tampered.subarray(0, asset.length)) });

      await expect(fetchVerifiedHelperInstaller(os)).rejects.toThrow(/size|digest mismatch/);
    });

    it('refuses when the Helper-directory manifest is signed by a key that is not trusted', async () => {
      stageHosted({ trustOfficialKey: false });

      await expect(fetchVerifiedHelperInstaller(os)).rejects.toThrow(/signature/i);
    });
  });

  describe('self-host layout (BINARY_EDITION=self-host)', () => {
    it('serves the Helper against the official manifest staged at the binaries root (unchanged layout)', async () => {
      const asset = Buffer.from('official-helper-appimage');
      const official = signedReleaseManifest(assetName, asset, {
        platformTrust: 'release-workflow-produced',
        edition: 'self-host',
      }, officialRelease);
      writeFileSync(join(helperDir, assetName), asset);
      writePair(root, official);
      setEnv('self-host', [official.publicKey]);

      await expect(fetchVerifiedHelperInstaller(os)).resolves.toMatchObject({ buffer: asset });
    });

    it('prefers a manifest pair staged in the Helper directory itself', async () => {
      const asset = Buffer.from('official-helper-appimage');
      const official = signedReleaseManifest(assetName, asset, {
        platformTrust: 'release-workflow-produced',
        edition: 'self-host',
      }, officialRelease);
      // A root manifest that does NOT cover the Helper: if the lookup picked
      // it over the Helper-directory pair this would fail as absent.
      const other = signedReleaseManifestEntries([], officialRelease);
      writeFileSync(join(helperDir, assetName), asset);
      writePair(helperDir, official);
      writePair(root, other);
      setEnv('self-host', [official.publicKey, other.publicKey]);

      await expect(fetchVerifiedHelperInstaller(os)).resolves.toMatchObject({ buffer: asset });
    });

    it('still refuses tampered bytes', async () => {
      const asset = Buffer.from('official-helper-appimage');
      const official = signedReleaseManifest(assetName, asset, {
        platformTrust: 'release-workflow-produced',
        edition: 'self-host',
      }, officialRelease);
      writeFileSync(join(helperDir, assetName), Buffer.from('official-helper-EVILimage').subarray(0, asset.length));
      writePair(root, official);
      setEnv('self-host', [official.publicKey]);

      await expect(fetchVerifiedHelperInstaller(os)).rejects.toThrow(/digest mismatch/);
    });
  });
});

describe('fetchMacosInstallerAppZip local trust', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('rejects substitution of a locally staged installer app zip', async () => {
    const root = mkdtempSync(join(tmpdir(), 'breeze-local-app-'));
    const binaryDir = join(root, 'agent');
    const assetName = 'Breeze Installer.app.zip';
    const asset = Buffer.from('trusted-app-zip');
    const signed = signedReleaseManifest(assetName, asset, {
      platformTrust: 'macos-developer-id-notarization-required',
      edition: 'self-host',
    });
    try {
      mkdirSync(binaryDir);
      writeFileSync(join(binaryDir, assetName), asset);
      writeFileSync(join(root, 'release-artifact-manifest.json'), signed.manifest);
      writeFileSync(join(root, 'release-artifact-manifest.json.ed25519'), signed.signature);
      process.env = {
        ...originalEnv,
        BINARY_SOURCE: 'local',
        BINARY_VERSION: '1.2.3',
        BINARY_EDITION: 'self-host',
        AGENT_BINARY_DIR: binaryDir,
        RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: signed.publicKey,
      };
      delete process.env.S3_BUCKET;
      delete process.env.S3_ACCESS_KEY;
      delete process.env.S3_SECRET_KEY;

      await expect(fetchMacosInstallerAppZip()).resolves.toEqual(asset);
      writeFileSync(join(binaryDir, assetName), Buffer.from('altered-app-zip'));
      await expect(fetchMacosInstallerAppZip()).rejects.toThrow(/digest mismatch/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildMacosInstallerZip', () => {
  it('produces a zip with enrollment.json and install.sh (no bundled pkg)', async () => {
    const validKey = realEnrollmentKey();

    const zipBuffer = await buildMacosInstallerZip({
      serverUrl: 'https://breeze.example.com',
      enrollmentKey: validKey,
      enrollmentSecret: 'secret456',
      siteId: '550e8400-e29b-41d4-a716-446655440000',
    });

    const zip = await JSZip.loadAsync(zipBuffer);
    const entries = Object.keys(zip.files);

    expect(entries).toContain('enrollment.json');
    expect(entries).toContain('install.sh');
    // The pkg is downloaded per-architecture at install time, not bundled —
    // this is what lets one zip work on both Intel and Apple Silicon.
    expect(entries).not.toContain('breeze-agent.pkg');

    const jsonStr = await zip.files['enrollment.json']!.async('string');
    const config = JSON.parse(jsonStr);
    expect(config.serverUrl).toBe('https://breeze.example.com');
    expect(config.enrollmentKey).toBe(validKey);
    expect(config.enrollmentSecret).toBe('secret456');
    expect(config.siteId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('sets enrollmentSecret to empty string when not provided', async () => {
    const zipBuffer = await buildMacosInstallerZip({
      serverUrl: 'https://x.com',
      enrollmentKey: realEnrollmentKey(),
      enrollmentSecret: '',
      siteId: '550e8400-e29b-41d4-a716-446655440000',
    });

    const zip = await JSZip.loadAsync(zipBuffer);
    const config = JSON.parse(await zip.files['enrollment.json']!.async('string'));
    expect(config.enrollmentSecret).toBe('');
  });

  it('rejects a key with the legacy brz_ prefix (drift guard)', async () => {
    await expect(
      buildMacosInstallerZip({
        serverUrl: 'https://x.com',
        enrollmentKey: 'brz_' + realEnrollmentKey(),
        enrollmentSecret: '',
        siteId: '550e8400-e29b-41d4-a716-446655440000',
      })
    ).rejects.toThrow(/invalid enrollment key/i);
  });
});

describe('buildMacosInstallerZip — install.sh content', () => {
  it('install.sh contains shebang and enrollment command', async () => {
    const zipBuffer = await buildMacosInstallerZip({
      serverUrl: 'https://x.com',
      enrollmentKey: realEnrollmentKey(),
      enrollmentSecret: '',
      siteId: '550e8400-e29b-41d4-a716-446655440000',
    });

    const zip = await JSZip.loadAsync(zipBuffer);
    const script = await zip.files['install.sh']!.async('string');
    expect(script).toContain('#!/bin/bash');
    expect(script).toContain('breeze-agent enroll');
    expect(script).toContain('enrollment.json');
  });

  it('install.sh detects CPU arch and downloads the matching pkg', async () => {
    const zipBuffer = await buildMacosInstallerZip({
      serverUrl: 'https://x.com',
      enrollmentKey: realEnrollmentKey(),
      enrollmentSecret: '',
      siteId: '550e8400-e29b-41d4-a716-446655440000',
    });

    const zip = await JSZip.loadAsync(zipBuffer);
    const script = await zip.files['install.sh']!.async('string');

    // Architecture detection — both Intel and Apple Silicon must be handled.
    expect(script).toContain('uname -m');
    expect(script).toMatch(/x86_64\|amd64/);
    expect(script).toMatch(/arm64\|aarch64/);

    // Per-arch download from the server's pkg endpoint (literal ${ARCH}, not
    // a JS-interpolated value — the bash variable must survive into the script).
    expect(script).toContain('/api/v1/agents/download/darwin/${ARCH}/pkg');
    expect(script).not.toContain('undefined');

    // Service restart so newly-enrolled config is picked up.
    expect(script).toContain('launchctl kickstart');
  });

  it('install.sh verifies pkg notarization before installing as root (security gate)', async () => {
    const zipBuffer = await buildMacosInstallerZip({
      serverUrl: 'https://x.com',
      enrollmentKey: realEnrollmentKey(),
      enrollmentSecret: '',
      siteId: '550e8400-e29b-41d4-a716-446655440000',
    });

    const zip = await JSZip.loadAsync(zipBuffer);
    const script = await zip.files['install.sh']!.async('string');

    // The installer CLI does not enforce Gatekeeper; the script must spctl-assess
    // (fail closed) BEFORE handing the downloaded pkg to `installer -pkg` as root.
    const gateIdx = script.indexOf('spctl --assess --type install');
    const installIdx = script.indexOf('installer -pkg');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(installIdx);
    expect(script).toMatch(/Refusing to install/);
  });

  it('install.sh binds digest and exact Developer ID Installer identity before root install', async () => {
    const zipBuffer = await buildMacosInstallerZip({
      serverUrl: 'https://x.com',
      enrollmentKey: realEnrollmentKey(),
      enrollmentSecret: '',
      siteId: '550e8400-e29b-41d4-a716-446655440000',
    });
    const zip = await JSZip.loadAsync(zipBuffer);
    const script = await zip.files['install.sh']!.async('string');

    const checksumIdx = script.indexOf('ACTUAL_SHA256=');
    const identityIdx = script.indexOf('pkgutil --check-signature');
    const gatekeeperIdx = script.indexOf('spctl --assess --type install');
    const installIdx = script.indexOf('installer -pkg');
    expect(checksumIdx).toBeGreaterThan(-1);
    expect(identityIdx).toBeGreaterThan(checksumIdx);
    expect(script).toContain('EXPECTED_TEAM_ID');
    expect(script).toContain('EXPECTED_SIGNING_IDENTITY');
    expect(script).toContain('privileged installer downloads require HTTPS');
    expect(gatekeeperIdx).toBeGreaterThan(identityIdx);
    expect(installIdx).toBeGreaterThan(gatekeeperIdx);
  });

  it('install.sh removes the credential file on any exit (no secret left behind)', async () => {
    const zipBuffer = await buildMacosInstallerZip({
      serverUrl: 'https://x.com',
      enrollmentKey: realEnrollmentKey(),
      enrollmentSecret: '',
      siteId: '550e8400-e29b-41d4-a716-446655440000',
    });

    const zip = await JSZip.loadAsync(zipBuffer);
    const script = await zip.files['install.sh']!.async('string');

    // enrollment.json holds the enrollment secret — the EXIT trap must remove it
    // so a failed/aborted install never leaves it in the extracted download dir.
    expect(script).toMatch(/trap '.*rm -f "\$ENROLLMENT_JSON".*' EXIT/);
  });
});

describe('assertMacosInstallerPkgsReachable', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    __resetVerifiedMacosPkgCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    __resetVerifiedMacosPkgCache();
  });

  it('github mode: verifies BOTH architecture packages (not just arm64)', async () => {
    process.env.BINARY_SOURCE = 'github';
    process.env.BINARY_VERSION = '1.2.3';
    const identity = 'Developer ID Installer: LanternOps LLC (D8W6N2JYMA)';
    const packages = {
      'breeze-agent-darwin-amd64.pkg': Buffer.from('amd64-pkg'),
      'breeze-agent-darwin-arm64.pkg': Buffer.from('arm64-pkg'),
    };
    const signed = signedReleaseManifestEntries(Object.entries(packages).map(([name, bytes]) => ({
      name,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      platformTrust: 'macos-developer-id-notarization-required',
      edition: 'self-host',
      signingIdentity: identity,
      signingTeamId: 'D8W6N2JYMA',
    })));
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(url);
      if (url.endsWith('/release-artifact-manifest.json')) return new Response(signed.manifest);
      if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(signed.signature);
      for (const [name, bytes] of Object.entries(packages)) {
        if (url.endsWith(`/${name}`)) return new Response(bytes);
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(assertMacosInstallerPkgsReachable()).resolves.toBeUndefined();
    expect(seen.some((u) => u.endsWith('breeze-agent-darwin-amd64.pkg'))).toBe(true);
    expect(seen.some((u) => u.endsWith('breeze-agent-darwin-arm64.pkg'))).toBe(true);
  });

  it('github mode: throws when signed verification metadata is unavailable', async () => {
    process.env.BINARY_SOURCE = 'github';
    process.env.BINARY_VERSION = '1.2.3';

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('breeze-agent-darwin-amd64.pkg')) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(assertMacosInstallerPkgsReachable()).rejects.toThrow(/amd64/);
  });

  it('local mode: refuses packages that lack the signed manifest pair', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'breeze-pkg-probe-'));
    try {
      process.env.BINARY_SOURCE = 'local';
      delete process.env.S3_BUCKET; // force the disk path, not the S3 early-return
      process.env.AGENT_BINARY_DIR = dir;
      writeFileSync(join(dir, 'breeze-agent-darwin-amd64.pkg'), 'x');
      writeFileSync(join(dir, 'breeze-agent-darwin-arm64.pkg'), 'x');

      await expect(assertMacosInstallerPkgsReachable()).rejects.toThrow(/amd64/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('local mode: throws when an arch package is missing on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'breeze-pkg-probe-'));
    try {
      process.env.BINARY_SOURCE = 'local';
      delete process.env.S3_BUCKET; // force the disk path, not the S3 early-return
      process.env.AGENT_BINARY_DIR = dir;
      writeFileSync(join(dir, 'breeze-agent-darwin-arm64.pkg'), 'x'); // amd64 missing

      await expect(assertMacosInstallerPkgsReachable()).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildWindowsInstallerZip', () => {
  it('rejects an enrollment key with shell-meaningful characters', async () => {
    await expect(
      buildWindowsInstallerZip(Buffer.from('msi'), {
        serverUrl: 'https://breeze.example.com',
        enrollmentKey: 'abc\nrm -rf /',
        enrollmentSecret: 'secret456',
        siteId: '550e8400-e29b-41d4-a716-446655440000',
      })
    ).rejects.toThrow(/invalid enrollment key/i);
  });

  it('rejects an enrollment key with the legacy brz_ prefix (drift guard)', async () => {
    await expect(
      buildWindowsInstallerZip(Buffer.from('msi'), {
        serverUrl: 'https://breeze.example.com',
        enrollmentKey: 'brz_' + realEnrollmentKey(),
        enrollmentSecret: 'secret456',
        siteId: '550e8400-e29b-41d4-a716-446655440000',
      })
    ).rejects.toThrow(/invalid enrollment key/i);
  });

  it('quotes ENROLLMENT_KEY in install.bat', async () => {
    const validKey = realEnrollmentKey();
    const zip = await buildWindowsInstallerZip(Buffer.from('msi'), {
      serverUrl: 'https://breeze.example.com',
      enrollmentKey: validKey,
      enrollmentSecret: 'secret456',
      siteId: '550e8400-e29b-41d4-a716-446655440000',
    });

    const zipInstance = await JSZip.loadAsync(zip);
    const batScript = await zipInstance.files['install.bat']!.async('string');
    expect(batScript).toContain(`set ENROLLMENT_KEY="${validKey}"`);
  });

  it('gates install.bat on elevation before running msiexec (#1832)', async () => {
    const zip = await buildWindowsInstallerZip(Buffer.from('msi'), {
      serverUrl: 'https://breeze.example.com',
      enrollmentKey: realEnrollmentKey(),
      enrollmentSecret: 'secret456',
      siteId: '550e8400-e29b-41d4-a716-446655440000',
    });
    const zipInstance = await JSZip.loadAsync(zip);
    const batScript = await zipInstance.files['install.bat']!.async('string');

    // Admin gate exists and runs before the msiexec install line.
    expect(batScript).toContain('net session >nul 2>&1');
    expect(batScript).toMatch(/must be run as Administrator/i);
    expect(batScript.indexOf('net session')).toBeLessThan(batScript.indexOf('msiexec /i'));

    // Success is no longer printed unconditionally: it must come after the
    // enroll exit-code guard, and msiexec failures abort the run.
    expect(batScript).toContain('set "MSI_RC=!errorlevel!"');
    expect(batScript).toContain('set "ENROLL_RC=!errorlevel!"');
    const guardIdx = batScript.indexOf('if not "!ENROLL_RC!"=="0"');
    const successIdx = batScript.indexOf('installed and enrolled successfully');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(successIdx);
  });
});

describe('serveWindowsBootstrapMsi', () => {
  // Minimal Hono Context stub capturing headers + body. Both Windows download
  // routes (enrollmentKeys.ts) delegate here, so this is the single source of
  // truth for the download filename.
  function fakeContext(): { c: Context; headers: Map<string, string>; body: Buffer | null } {
    const headers = new Map<string, string>();
    const state: { body: Buffer | null } = { body: null };
    const c = {
      header: (k: string, v: string) => headers.set(k.toLowerCase(), v),
      body: (b: Buffer) => {
        state.body = b;
        return new Response();
      },
    } as unknown as Context;
    return { c, headers, body: state.body };
  }

  it('wraps the bootstrap token in PARENTHESES, never square brackets', () => {
    const { c, headers } = fakeContext();
    serveWindowsBootstrapMsi(c, {
      msi: Buffer.from('signed-msi-bytes'),
      token: 'ABCDE12345',
      apiHost: 'api.example.com',
    });

    const cd = headers.get('content-disposition');
    expect(cd).toBe(
      'attachment; filename="Breeze Agent (ABCDE12345@api.example.com).msi"',
    );
    // Regression guard for #1956: a square-bracket [TOKEN@HOST] delimiter is
    // eaten by MSI's Formatted-field engine, dropping the token so agents never
    // enroll. If someone reverts the delimiter, this fails — the route-level
    // tests can't catch it because they mock this function.
    expect(cd).not.toContain('[');
    expect(cd).not.toContain(']');
  });

  it('carries a nonstandard port as host_PORT, never host:port (#2341)', () => {
    // `:` is illegal in Windows filenames — the browser rewrites it at save
    // time and the agent parser then never matches, so the device installs
    // unenrolled with no visible error. The port rides as `_PORT` instead.
    const { c, headers } = fakeContext();
    serveWindowsBootstrapMsi(c, {
      msi: Buffer.from('signed-msi-bytes'),
      token: 'ABCDE12345',
      apiHost: 'rmm.example.com_8443',
    });

    expect(headers.get('content-disposition')).toBe(
      'attachment; filename="Breeze Agent (ABCDE12345@rmm.example.com_8443).msi"',
    );
  });

  it('rejects an apiHost that is not Windows-filename-safe (#2341)', () => {
    // Defense-in-depth: callers encode via windowsFilenameApiHost(), but a
    // raw `host:port` reaching this point must throw rather than serve an
    // MSI whose token the agent can never parse back out.
    const { c } = fakeContext();
    expect(() =>
      serveWindowsBootstrapMsi(c, {
        msi: Buffer.from('signed-msi-bytes'),
        token: 'ABCDE12345',
        apiHost: 'rmm.example.com:8443',
      }),
    ).toThrow(/not safe for a Windows installer filename/);
  });

  it('serves the MSI bytes unmodified with octet-stream + no-store headers', () => {
    const { c, headers } = fakeContext();
    const msi = Buffer.from('signed-msi-bytes');
    serveWindowsBootstrapMsi(c, { msi, token: 'ZZZZZ99999', apiHost: 'eu.2breeze.app' });

    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('content-length')).toBe(String(msi.length));
    expect(headers.get('cache-control')).toBe('no-store');
  });
});

// #7830: a self-hoster holding the fleet at BINARY_VERSION=0.104 got a 503
// "edition mismatch … expected self-host, got undefined" on every installer —
// no manifest before v0.105.0 records `edition`. Exercised end to end through
// the pinned GitHub release URLs, against the unpinned (latest) control.
describe('installers for a BINARY_VERSION pinned before the edition field (#7830)', () => {
  const originalEnv = process.env;
  const identity = 'Developer ID Installer: LanternOps LLC (D8W6N2JYMA)';

  beforeEach(() => {
    process.env = { ...originalEnv };
    safeFetchFollowingRedirectsMock.mockClear();
    __resetVerifiedMacosPkgCache();
    __resetVerifiedHelperInstallerCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    __resetVerifiedMacosPkgCache();
    __resetVerifiedHelperInstallerCache();
  });

  function serveRelease(
    tagPath: string,
    signed: { manifest: Buffer; signature: Buffer; publicKey: string },
    assets: Record<string, Buffer>,
  ): string[] {
    process.env.BINARY_SOURCE = 'github';
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(url);
      if (!url.includes(tagPath)) return new Response('not found', { status: 404 });
      if (url.endsWith('/release-artifact-manifest.json')) return new Response(new Uint8Array(signed.manifest));
      if (url.endsWith('/release-artifact-manifest.json.ed25519')) {
        return new Response(new Uint8Array(signed.signature));
      }
      for (const [name, bytes] of Object.entries(assets)) {
        if (url.endsWith(`/${name}`)) return new Response(new Uint8Array(bytes));
      }
      return new Response('not found', { status: 404 });
    }));
    return seen;
  }

  it('pinned: serves a Helper installer from a v0.104.0 release whose manifest has no edition', async () => {
    const os = 'linux';
    const assetName = HELPER_FILENAMES[os]!;
    const asset = Buffer.from('v0.104.0 helper appimage');
    const signed = signedReleaseManifest(
      assetName,
      asset,
      { platformTrust: 'release-workflow-produced' },
      { release: 'v0.104.0' },
    );
    process.env.BINARY_VERSION = '0.104.0';
    const seen = serveRelease('/download/v0.104.0/', signed, { [assetName]: asset });

    await expect(fetchVerifiedHelperInstaller(os)).resolves.toMatchObject({
      buffer: asset,
      artifact: { release: 'v0.104.0', edition: null },
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.includes('/download/v0.104.0/'))).toBe(true);
  });

  it('unpinned (latest): refuses a replayed pre-v0.105.0 manifest instead of downgrading', async () => {
    const os = 'linux';
    const assetName = HELPER_FILENAMES[os]!;
    const asset = Buffer.from('v0.104.0 helper appimage');
    const signed = signedReleaseManifest(
      assetName,
      asset,
      { platformTrust: 'release-workflow-produced' },
      { release: 'v0.104.0' },
    );
    delete process.env.BINARY_VERSION;
    serveRelease('/latest/download/', signed, { [assetName]: asset });

    await expect(fetchVerifiedHelperInstaller(os)).rejects.toThrow(
      /edition mismatch.*only when BINARY_VERSION pins it explicitly/,
    );
  });

  it('pinned: refuses the macOS pkg with an operator-actionable reason, not an edition mismatch', async () => {
    const packages = {
      'breeze-agent-darwin-amd64.pkg': Buffer.from('v0.104.0 amd64 pkg'),
      'breeze-agent-darwin-arm64.pkg': Buffer.from('v0.104.0 arm64 pkg'),
    };
    // Exactly the v0.104.0 manifest shape: platformTrust, no edition, no
    // signingIdentity/signingTeamId (first recorded in v0.112.0).
    const signed = signedReleaseManifestEntries(
      Object.entries(packages).map(([name, bytes]) => ({
        name,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        platformTrust: 'macos-developer-id-notarization-required',
      })),
      { release: 'v0.104.0' },
    );
    process.env.BINARY_VERSION = '0.104.0';
    serveRelease('/download/v0.104.0/', signed, packages);

    const err = await assertMacosInstallerPkgsReachable().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.cause).toBeInstanceOf(ReleaseManifestTooOldError);
    const cause = err!.cause as ReleaseManifestTooOldError;
    expect(cause.message).not.toMatch(/edition mismatch/);
    expect(cause.message).toMatch(/BINARY_VERSION.*v0\.112\.0 or later/);
    expect(cause.minimumRelease).toBe('v0.112.0');
  });

  it('unpinned (latest): a current manifest with edition + publisher still serves the macOS pkg', async () => {
    const assetName = 'breeze-agent-darwin-arm64.pkg';
    const asset = Buffer.from('latest arm64 pkg');
    const signed = signedReleaseManifest(
      assetName,
      asset,
      {
        platformTrust: 'macos-developer-id-notarization-required',
        edition: 'self-host',
        signingIdentity: identity,
        signingTeamId: 'D8W6N2JYMA',
      },
      { release: 'v0.120.0' },
    );
    delete process.env.BINARY_VERSION;
    serveRelease('/latest/download/', signed, { [assetName]: asset });

    await expect(fetchVerifiedMacosPkg('arm64')).resolves.toMatchObject({
      buffer: asset,
      artifact: { release: 'v0.120.0', edition: 'self-host', signingTeamId: 'D8W6N2JYMA' },
    });
  });
});
