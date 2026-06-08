import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import JSZip from 'jszip';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMacosInstallerZip,
  buildWindowsInstallerZip,
  fetchRegularMsi,
  assertMacosInstallerPkgsReachable,
} from './installerBuilder';

// Real keys are 64 lowercase hex chars produced by randomBytes(32).toString('hex').
// Tests use that exact generator so a future drift between generator and validator
// fails here loudly.
function realEnrollmentKey(): string {
  return randomBytes(32).toString('hex');
}

function signedReleaseManifest(assetName: string, assetBuffer: Buffer) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const rawPublicKey = publicDer.subarray(publicDer.length - 32).toString('base64');
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    repository: 'lanternops/breeze',
    release: 'v1.2.3',
    assets: [
      {
        name: assetName,
        sha256: createHash('sha256').update(assetBuffer).digest('hex'),
        size: assetBuffer.length,
        platformTrust: 'windows-authenticode-required',
      },
    ],
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
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
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
    expect(fetchMock).toHaveBeenCalledWith(
      'https://github.com/lanternops/breeze/releases/download/v1.2.3/release-artifact-manifest.json.ed25519',
      { redirect: 'follow' },
    );
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
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('github mode: HEAD-checks BOTH architectures (not just arm64)', async () => {
    process.env.BINARY_SOURCE = 'github';
    process.env.BINARY_VERSION = '1.2.3';

    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
      seen.push(url);
      expect(opts?.method).toBe('HEAD');
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(assertMacosInstallerPkgsReachable()).resolves.toBeUndefined();
    expect(seen.some((u) => u.endsWith('breeze-agent-darwin-amd64.pkg'))).toBe(true);
    expect(seen.some((u) => u.endsWith('breeze-agent-darwin-arm64.pkg'))).toBe(true);
  });

  it('github mode: throws when an architecture is unreachable (Intel-only outage guard)', async () => {
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

  it('local mode: resolves when both arch packages exist on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'breeze-pkg-probe-'));
    try {
      process.env.BINARY_SOURCE = 'local';
      delete process.env.S3_BUCKET; // force the disk path, not the S3 early-return
      process.env.AGENT_BINARY_DIR = dir;
      writeFileSync(join(dir, 'breeze-agent-darwin-amd64.pkg'), 'x');
      writeFileSync(join(dir, 'breeze-agent-darwin-arm64.pkg'), 'x');

      await expect(assertMacosInstallerPkgsReachable()).resolves.toBeUndefined();
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
});
