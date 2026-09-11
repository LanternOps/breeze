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
  __resetVerifiedMacosPkgCache,
  assertMacosInstallerPkgsReachable,
  serveWindowsBootstrapMsi,
} from './installerBuilder';
import type { Context } from 'hono';
import * as s3Storage from './s3Storage';

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
) {
  return signedReleaseManifestEntries([
    {
      name: assetName,
      sha256: createHash('sha256').update(assetBuffer).digest('hex'),
      size: assetBuffer.length,
      platformTrust: 'windows-authenticode-required',
      ...assetOverrides,
    },
  ]);
}

function signedReleaseManifestEntries(assets: Record<string, unknown>[]) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const rawPublicKey = publicDer.subarray(publicDer.length - 32).toString('base64');
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    repository: 'lanternops/breeze',
    release: 'v1.2.3',
    assets,
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
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetVerifiedMacosPkgCache();
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
