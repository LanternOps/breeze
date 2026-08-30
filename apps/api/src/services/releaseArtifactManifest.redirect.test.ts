/**
 * Regression suite for release-manifest verification redirects.
 *
 * GitHub release asset URLs normally redirect from `github.com` to
 * `objects.githubusercontent.com`. Following those redirects with the global
 * fetch implementation let an otherwise trusted first URL redirect the
 * verification inputs into metadata/link-local/private space. These cases pin
 * both required properties: normal GitHub redirects still work, and every hop
 * is independently DNS-resolved, filtered, and IP-pinned before it is dialed.
 *
 * This file does NOT mock `./urlSafety` — the guard runs for real here. Only
 * DNS and the socket layer are stubbed.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {}, assertOutsideHeldDbContext: vi.fn() }));

import { verifyGithubReleaseArtifactBuffer } from './releaseArtifactManifest';
import { requiredPlatformTrustFor } from './releaseAssetTrust';
import {
  ResponseTooLargeError,
  SsrfBlockedError,
  __setLookupForTests,
} from './urlSafety';

type StubbedResponse =
  | { status: number; headers?: Record<string, string>; body?: Buffer }
  | { networkError: string };

interface RecordedRequest {
  protocol: 'http' | 'https';
  host: string;
  path: string;
}

/**
 * The signed-asset redirect carries a `?token=` query, so every path comparison
 * below has to ignore it. `split` is typed as possibly-empty under
 * noUncheckedIndexedAccess, hence the fallback rather than a bare `[0]`.
 */
function pathWithoutQuery(path: string): string {
  return path.split('?')[0] ?? path;
}

function installRequestStub(
  handler: (req: RecordedRequest) => StubbedResponse,
): { requests: RecordedRequest[]; restore: () => void } {
  const requests: RecordedRequest[] = [];

  const makeImpl = (protocol: 'http' | 'https') =>
    ((options: any, callback?: any) => {
      const recorded: RecordedRequest = {
        protocol,
        host: String(options.host),
        path: String(options.path),
      };
      requests.push(recorded);
      const outcome = handler(recorded);

      const req = new EventEmitter() as any;
      req.write = vi.fn();
      req.destroy = vi.fn();
      req.setTimeout = vi.fn();
      req.end = vi.fn(() => {
        if ('networkError' in outcome) {
          req.emit('error', new Error(outcome.networkError));
          return;
        }
        const res = new EventEmitter() as any;
        res.statusCode = outcome.status;
        res.statusMessage = '';
        res.headers = outcome.headers ?? {};
        res.setEncoding = vi.fn();
        callback?.(res);
        if (outcome.body) res.emit('data', outcome.body);
        res.emit('end');
      });
      return req;
    }) as any;

  const httpsSpy = vi.spyOn(https, 'request').mockImplementation(makeImpl('https'));
  const httpSpy = vi.spyOn(http, 'request').mockImplementation(makeImpl('http'));
  return {
    requests,
    restore: () => {
      httpsSpy.mockRestore();
      httpSpy.mockRestore();
    },
  };
}

function makeSignedManifest(assetName: string, assetBuffer: Buffer) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const rawPublicKey = publicDer.subarray(publicDer.length - 32).toString('base64');
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      repository: 'lanternops/breeze',
      release: 'v1.2.3',
      assets: [
        {
          name: assetName,
          sha256: createHash('sha256').update(assetBuffer).digest('hex'),
          size: assetBuffer.length,
          platformTrust:
            requiredPlatformTrustFor(assetName) ?? 'release-workflow-produced',
        },
      ],
    }),
  );
  return {
    manifest,
    signature: Buffer.from(sign(null, manifest, privateKey).toString('base64')),
    publicKey: rawPublicKey,
  };
}

const MANIFEST_URL =
  'https://github.com/LanternOps/breeze/releases/download/v1.2.3/release-artifact-manifest.json';
const SIGNATURE_URL = `${MANIFEST_URL}.ed25519`;

function verifyAsset(asset: Buffer) {
  return verifyGithubReleaseArtifactBuffer({
    assetName: 'breeze-agent.msi',
    assetBuffer: asset,
    manifestUrl: MANIFEST_URL,
    signatureUrl: SIGNATURE_URL,
    expectedRepository: 'lanternops/breeze',
    expectedRelease: 'v1.2.3',
  });
}

describe('verifyGithubReleaseArtifactBuffer — GitHub manifest redirects', () => {
  const originalEnv = process.env;
  let restoreRequests: (() => void) | undefined;

  beforeEach(() => {
    process.env = { ...originalEnv };
    __setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(() => {
    process.env = originalEnv;
    __setLookupForTests(null);
    restoreRequests?.();
    restoreRequests = undefined;
  });

  it('follows normal GitHub redirects and verifies the manifest and signature', async () => {
    const asset = Buffer.from('trusted-github-msi');
    const signed = makeSignedManifest('breeze-agent.msi', asset);
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    const stub = installRequestStub((req) => {
      if (req.host === 'github.com') {
        return {
          status: 302,
          headers: {
            location: `https://objects.githubusercontent.com/breeze${req.path}?token=abc`,
          },
        };
      }
      if (req.host === 'objects.githubusercontent.com') {
        const requestPath = pathWithoutQuery(req.path);
        return {
          status: 200,
          body: requestPath.endsWith('.ed25519') ? signed.signature : signed.manifest,
        };
      }
      return { status: 404, body: Buffer.from('not found') };
    });
    restoreRequests = stub.restore;

    await expect(verifyAsset(asset)).resolves.toEqual(
      expect.objectContaining({
        assetName: 'breeze-agent.msi',
        release: 'v1.2.3',
        repository: 'lanternops/breeze',
      }),
    );

    const hostsFor = (suffix: string) =>
      stub.requests
        .filter((req) => pathWithoutQuery(req.path).endsWith(suffix))
        .map((req) => req.host);
    expect(hostsFor('/release-artifact-manifest.json')).toEqual([
      'github.com',
      'objects.githubusercontent.com',
    ]);
    expect(hostsFor('/release-artifact-manifest.json.ed25519')).toEqual([
      'github.com',
      'objects.githubusercontent.com',
    ]);
  });

  it('REJECTS a redirect to the cloud metadata service without dialing it', async () => {
    const asset = Buffer.from('trusted-github-msi');
    const signed = makeSignedManifest('breeze-agent.msi', asset);
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    const stub = installRequestStub((req) => {
      if (req.host === 'github.com' && !req.path.endsWith('.ed25519')) {
        return {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/iam/' },
        };
      }
      return { status: 200, body: signed.signature };
    });
    restoreRequests = stub.restore;

    const err = await verifyAsset(asset).catch((error) => error);
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect(String(err)).toMatch(/169\.254\.169\.254/);
    expect(stub.requests.map((req) => req.host)).not.toContain('169.254.169.254');
    expect(stub.requests.filter((req) => !req.path.endsWith('.ed25519'))).toHaveLength(1);
  });

  it('REJECTS a redirect whose hostname resolves to RFC1918 without dialing it', async () => {
    const asset = Buffer.from('trusted-github-msi');
    const signed = makeSignedManifest('breeze-agent.msi', asset);
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
    __setLookupForTests(async (hostname: string) =>
      hostname === 'internal.example'
        ? [{ address: '192.168.1.10', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }],
    );

    const stub = installRequestStub((req) => {
      if (req.host === 'github.com' && !req.path.endsWith('.ed25519')) {
        return {
          status: 302,
          headers: { location: 'https://internal.example/release-artifact-manifest.json' },
        };
      }
      return { status: 200, body: signed.signature };
    });
    restoreRequests = stub.restore;

    const err = await verifyAsset(asset).catch((error) => error);
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect(String(err)).toMatch(/internal\.example|192\.168\.1\.10/);
    expect(stub.requests.map((req) => req.host)).not.toContain('internal.example');
    expect(stub.requests.filter((req) => !req.path.endsWith('.ed25519'))).toHaveLength(1);
  });

  it('aborts an oversized manifest at the streaming ceiling', async () => {
    // The maxBytes argument is new with the guard, and it fires DURING the
    // response stream — so it pre-empts fetchSmallBuffer's own post-hoc length
    // checks rather than being backed by them. Pin that the overrun surfaces as
    // a thrown ResponseTooLargeError (never a truncated buffer handed onward to
    // signature verification, which is the dangerous way to fail here).
    const asset = Buffer.from('trusted-github-msi');
    const signed = makeSignedManifest('breeze-agent.msi', asset);
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    const oversized = Buffer.alloc(1024 * 1024 + 1, 0x61);
    const stub = installRequestStub((req) =>
      pathWithoutQuery(req.path).endsWith('.ed25519')
        ? { status: 200, body: signed.signature }
        : { status: 200, body: oversized },
    );
    restoreRequests = stub.restore;

    const err = await verifyAsset(asset).catch((error) => error);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
  });

  it('contains no raw fetch call and adopts the redirect-safe helper', () => {
    const servicesDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(servicesDir, 'releaseArtifactManifest.ts'), 'utf8');

    // Bare `fetch(` — the exact shape that was reverted-to would look like.
    expect(source).not.toMatch(/(?<![.\w])fetch\s*\(/);
    // …and the qualified spellings the lookbehind above deliberately exempts,
    // so `globalThis.fetch(url)` cannot reintroduce the hole past this guard.
    expect(source).not.toMatch(/\b(?:globalThis|window|global)\s*\.\s*fetch\s*\(/);
    // Positive half: the helper must actually be CALLED, not merely imported —
    // an orphaned import would satisfy a bare identifier match.
    expect(source).toMatch(/safeFetchFollowingRedirects\s*\(/);
  });
});
