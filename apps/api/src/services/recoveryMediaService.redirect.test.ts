/**
 * Regression suite for the recovery-media download path and redirects.
 *
 * `downloadFile()` fetches the backup binary from a GitHub release asset URL,
 * and those 302 to `objects.githubusercontent.com`. When the SSRF adoption pass
 * converted the call to a bare `safeFetch` — which follows nothing by design —
 * every recovery-media build started failing with `download failed with status
 * 302`. These cases pin the fixed behaviour AND the property that makes
 * following safe: each hop is re-validated, so a redirect into
 * metadata/link-local/private space is rejected rather than followed.
 *
 * Unlike `recoveryMediaService.test.ts`, this file does NOT mock `./urlSafety`
 * — the guard runs for real here. Only DNS and the socket layer are stubbed.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {}, assertOutsideHeldDbContext: vi.fn() }));
vi.mock('./recoveryBootstrap', () => ({
  asRecord: (v: unknown) => (v && typeof v === 'object' ? v : {}),
  getStringValue: () => null,
  resolveServerUrl: () => 'https://breeze.example.com',
  resolveSnapshotProviderConfig: vi.fn(),
}));
vi.mock('./recoverySigning', () => ({
  getRecoverySigningKey: () => null,
  isRecoverySigningConfigured: () => false,
  signRecoveryArtifact: vi.fn(),
}));
// Manifest verification is exercised by recoveryMediaService.test.ts; here it
// must not be the thing that fails, so the download outcome is unambiguous.
vi.mock('./releaseArtifactManifest', () => ({
  verifyGithubReleaseArtifactBuffer: vi.fn(async () => ({
    sha256: 'a'.repeat(64),
    release: 'v1.2.3',
  })),
}));

import { resolveBackupBinary } from './recoveryMediaService';
import { SsrfBlockedError, __setLookupForTests } from './urlSafety';

const BINARY_BYTES = Buffer.from('backup binary bytes');

type StubbedResponse =
  | { status: number; headers?: Record<string, string>; body?: Buffer }
  | { networkError: string };

/** One entry per request the code under test is expected to make. */
interface RecordedRequest {
  protocol: 'http' | 'https';
  host: string;
  path: string;
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

describe('resolveBackupBinary — GitHub asset redirects', () => {
  const originalEnv = process.env;
  let workingDir: string;
  let restoreRequests: (() => void) | undefined;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    delete process.env.BINARY_SOURCE; // github is the default
    delete process.env.BINARY_GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPO;
    process.env.BINARY_VERSION = '1.2.3';
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = 'x'.repeat(44);
    workingDir = await mkdtemp(join(tmpdir(), 'recovery-redirect-test-'));
    // Every hostname resolves to a public address unless a case says otherwise;
    // literal IPs (the SSRF cases) never reach DNS at all.
    __setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(async () => {
    process.env = originalEnv;
    __setLookupForTests(null);
    restoreRequests?.();
    restoreRequests = undefined;
    await rm(workingDir, { recursive: true, force: true });
  });

  it('follows a 302 to a different host and downloads the asset', async () => {
    const stub = installRequestStub((req) => {
      if (req.host === 'github.com') {
        return {
          status: 302,
          headers: {
            location:
              'https://objects.githubusercontent.com/breeze/breeze-backup-linux-amd64?token=abc',
          },
        };
      }
      if (req.host === 'objects.githubusercontent.com') {
        return { status: 200, body: BINARY_BYTES };
      }
      return { status: 404, body: Buffer.from('not found') };
    });
    restoreRequests = stub.restore;

    const result = await resolveBackupBinary('linux', 'amd64', workingDir);

    expect(await readFile(result.filePath)).toEqual(BINARY_BYTES);
    expect(stub.requests.map((r) => r.host)).toEqual([
      'github.com',
      'objects.githubusercontent.com',
    ]);
  });

  it('follows a relative Location against the current URL', async () => {
    const stub = installRequestStub((req) => {
      if (req.path.includes('/releases/download/')) {
        return { status: 302, headers: { location: '/redirected/asset.bin' } };
      }
      return { status: 200, body: BINARY_BYTES };
    });
    restoreRequests = stub.restore;

    await resolveBackupBinary('linux', 'amd64', workingDir);

    expect(stub.requests[1]).toMatchObject({
      host: 'github.com',
      path: '/redirected/asset.bin',
    });
  });

  it('REJECTS a redirect that points at the cloud metadata service', async () => {
    // The security-critical case: naive redirect-following is a classic SSRF
    // bypass. The second hop must never be dialed.
    const stub = installRequestStub((req) => {
      if (req.host === 'github.com') {
        return {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' },
        };
      }
      return { status: 200, body: Buffer.from('SECRET CREDENTIALS') };
    });
    restoreRequests = stub.restore;

    const err = await resolveBackupBinary('linux', 'amd64', workingDir).catch((e) => e);
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect(String(err)).toMatch(/169\.254\.169\.254/);
    expect(stub.requests.map((r) => r.host)).toEqual(['github.com']);
  });

  it('REJECTS a redirect that points at an RFC1918 address', async () => {
    const stub = installRequestStub((req) => {
      if (req.host === 'github.com') {
        return { status: 302, headers: { location: 'http://10.0.0.5:9000/internal' } };
      }
      return { status: 200, body: Buffer.from('internal service response') };
    });
    restoreRequests = stub.restore;

    const err = await resolveBackupBinary('linux', 'amd64', workingDir).catch((e) => e);
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect(stub.requests.map((r) => r.host)).toEqual(['github.com']);
  });

  it('REJECTS a redirect whose hostname resolves to a private address', async () => {
    // Same bypass, one indirection deeper: the Location looks public and only
    // DNS reveals the internal target. Re-validating every hop catches it.
    __setLookupForTests(async (hostname: string) =>
      hostname === 'internal.example'
        ? [{ address: '192.168.1.10', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }],
    );
    const stub = installRequestStub((req) => {
      if (req.host === 'github.com') {
        return { status: 302, headers: { location: 'https://internal.example/asset' } };
      }
      return { status: 200, body: Buffer.from('internal service response') };
    });
    restoreRequests = stub.restore;

    const err = await resolveBackupBinary('linux', 'amd64', workingDir).catch((e) => e);
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect(stub.requests.map((r) => r.host)).toEqual(['github.com']);
  });

  it('errors instead of looping when the hop cap is exhausted', async () => {
    let hop = 0;
    const stub = installRequestStub(() => {
      hop += 1;
      return { status: 302, headers: { location: `https://hop${hop}.example/next` } };
    });
    restoreRequests = stub.restore;

    await expect(resolveBackupBinary('linux', 'amd64', workingDir)).rejects.toThrow(
      /too many redirects/,
    );
    // The initial request plus SAFE_FETCH_MAX_REDIRECTS follow-ups, then stop.
    expect(stub.requests).toHaveLength(6);
  });

  it('rejects a redirect with no Location header', async () => {
    const stub = installRequestStub(() => ({ status: 302 }));
    restoreRequests = stub.restore;

    await expect(resolveBackupBinary('linux', 'amd64', workingDir)).rejects.toThrow(
      /no Location header/,
    );
  });

  it('preserves the original error shape for a non-redirect failure', async () => {
    const stub = installRequestStub(() => ({ status: 404, body: Buffer.from('nope') }));
    restoreRequests = stub.restore;

    await expect(resolveBackupBinary('linux', 'amd64', workingDir)).rejects.toThrow(
      'download failed with status 404',
    );
  });
});
