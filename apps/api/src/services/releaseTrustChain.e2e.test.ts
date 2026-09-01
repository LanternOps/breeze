import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn(() => ({ onConflictDoUpdate }));
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const tx = {
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: updateWhere })) })),
    insert: vi.fn(() => ({ values: insertValues })),
  };
  return {
    insertValues,
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn(tx)),
  };
});
vi.mock('../db', () => ({
  db: { transaction: dbMocks.transaction },
  // Required by urlSafety's safeFetch (#1105 tripwire) now that binarySync
  // routes its downloads through it.
  assertOutsideHeldDbContext: vi.fn(),
}));
// binarySync's fetches go through the SSRF-guarded helper (#4262), which dials
// http/https directly and never touches global `fetch`. Bridge it back to the
// stubbed global or the `vi.stubGlobal('fetch', …)` below stops intercepting
// and this suite makes real network calls.
//
// SCOPE WARNING: this mock is module-wide, so it also un-guards
// releaseArtifactManifest.ts's `fetchSmallBuffer`, which imports the same
// helper. Inert today — this suite never reaches
// `verifyGithubReleaseArtifactBuffer`'s URL-fetching path — but a future e2e
// case added here would be silently unguarded. If you add one, assert its
// guard semantics in `binarySync.redirect.test.ts` (which does NOT mock
// urlSafety) rather than here.
vi.mock('./urlSafety', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./urlSafety')>()),
  // Typed against SafeFetchInit (not RequestInit) so a call site's `maxBytes` /
  // `timeoutMs` survive the bridge instead of being silently dropped, and a
  // vi.fn() so a suite CAN assert on what binarySync passed the helper.
  safeFetchFollowingRedirects: vi.fn(
    (url: string, init?: import('./urlSafety').SafeFetchInit) =>
      globalThis.fetch(url, init as RequestInit),
  ),
}));
vi.mock('./s3Storage', () => ({ isS3Configured: () => false, syncDirectory: vi.fn() }));

// Deployment key = the FIXTURE key: signManifest signs with the fixture seed so
// the sync output must be byte-identical to what the Go updater test verifies.
// Everything the mock factory touches lives inside vi.hoisted(): static imports
// are hoisted above module-body consts, and the factory runs while
// './binarySync' is being imported — a plain top-level const would still be in
// its temporal dead zone at that point.
const trustChainSigner = vi.hoisted(() => {
  const { createPrivateKey, sign } =
    require('node:crypto') as typeof import('node:crypto');
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS8 Ed25519 prefix
      Buffer.from(
        '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', // fixture seed
        'hex',
      ),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  return {
    keyId: 'deploy-fixture-trustchain',
    ensureActiveSigningKey: vi.fn(async () => ({
      keyId: 'deploy-fixture-trustchain',
      publicKeyB64: '',
    })),
    signManifest: vi.fn(async (json: string) =>
      sign(null, Buffer.from(json, 'utf8'), privateKey).toString('base64'),
    ),
  };
});
vi.mock('./manifestSigning', () => ({
  ensureActiveSigningKey: trustChainSigner.ensureActiveSigningKey,
  signManifest: trustChainSigner.signManifest,
}));

import { syncFromGitHub } from './binarySync';
import { verifyReleaseArtifactManifestAsset } from './releaseArtifactManifest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixture = JSON.parse(
  readFileSync(
    path.join(REPO_ROOT, 'agent/internal/updater/testdata/deployment_signed_manifest.json'),
    'utf8',
  ),
) as {
  keyId: string;
  publicKeyB64: string;
  entries: Array<{
    platform: string;
    arch: string;
    url: string;
    checksum: string;
    manifest: string;
    signatureB64: string;
  }>;
};

function rawPub(publicKey: import('node:crypto').KeyObject): string {
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(der.length - 32).toString('base64');
}

function signManifestBytes(
  manifest: Buffer,
  privateKey: import('node:crypto').KeyObject,
): Buffer {
  return Buffer.from(sign(null, manifest, privateKey).toString('base64'));
}

// Pins the exact bytes of the committed Go fixture. Mirrors
// deploymentFixtureSHA256 in
// agent/internal/updater/deployment_trustchain_test.go.
//
// The fixture is the only thing tying this API's re-signing output to what the
// shipped agent accepts, and it is regenerable by script — so without a pin,
// the cheapest way to green a red trust-chain test is to re-run the generator,
// silently turning a broken trust chain into a two-file edit. Requiring the
// hash to be updated in TWO languages makes that a deliberate act.
const DEPLOYMENT_FIXTURE_SHA256 =
  '81cd0453706322c83fb127727745a6feecd130356944a1cd9c9aa141317a74bc';

it('the committed Go fixture bytes are pinned (regenerating is not a fix)', () => {
  const fixturePath = path.join(
    REPO_ROOT,
    'agent/internal/updater/testdata/deployment_signed_manifest.json',
  );
  const actual = createHash('sha256').update(readFileSync(fixturePath)).digest('hex');
  expect(actual).toBe(DEPLOYMENT_FIXTURE_SHA256);
});

describe('trust-chain E2E: official key → self-hoster release key → deployment key (spec 3b/3c)', () => {
  const originalEnv = process.env;
  const REPO = 'acme/breeze-selfhost-signing';
  const CHECKSUM = createHash('sha256').update('trust-chain-fixture-binary').digest('hex');

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.GITHUB_REPO;
    delete process.env.BINARY_GITHUB_REPOSITORY;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('layer 1 — the official source key verifies canonical assets and rejects signing inputs', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519'); // official key
    const officialManifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        repository: 'LanternOps/breeze',
        release: 'v9.9.9',
        assets: [
          {
            name: 'breeze-agent-windows-amd64.exe',
            sha256: CHECKSUM,
            size: 4096,
            platformTrust: 'windows-authenticode-required',
          },
          {
            name: 'breeze-agent-windows-amd64-unsigned.exe',
            sha256: CHECKSUM,
            size: 4096,
            platformTrust: 'none',
            intendedUse: 'signing-input',
          },
        ],
      }),
    );
    const signature = signManifestBytes(officialManifest, privateKey);
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = rawPub(publicKey);

    // The template workflow's verification of official inputs is out of repo;
    // in-repo, layer 1 means: the official key gates canonical assets, and the
    // API can NEVER register/serve a signing input even from a valid manifest.
    await expect(
      verifyReleaseArtifactManifestAsset({
        assetName: 'breeze-agent-windows-amd64.exe',
        manifestBytes: officialManifest,
        signatureBytes: signature,
      }),
    ).resolves.toMatchObject({ platformTrust: 'windows-authenticode-required' });
    await expect(
      verifyReleaseArtifactManifestAsset({
        assetName: 'breeze-agent-windows-amd64-unsigned.exe',
        manifestBytes: officialManifest,
        signatureBytes: signature,
      }),
    ).rejects.toThrow(/not distributable/);
  });

  it('layers 2+3 — self-hoster release key gates the sync; deployment key output matches the Go-verified fixture bytes', async () => {
    process.env.BINARY_GITHUB_REPOSITORY = REPO;
    process.env.BINARY_VERSION = '9.9.9';

    const officialKey = generateKeyPairSync('ed25519'); // distinct key #1
    const selfHosterKey = generateKeyPairSync('ed25519'); // distinct key #2
    // distinct key #3 is the fixture deployment seed inside the signManifest mock.

    const releaseManifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        repository: REPO,
        release: 'v9.9.9',
        assets: [
          {
            name: 'breeze-agent-linux-amd64',
            sha256: CHECKSUM,
            size: 4096,
            platformTrust: 'release-workflow-produced',
          },
        ],
      }),
    );
    const selfHosterSig = signManifestBytes(releaseManifest, selfHosterKey.privateKey);
    const officialSig = signManifestBytes(releaseManifest, officialKey.privateKey);

    const stub = (signatureBody: Buffer) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.includes('/releases/tags/v9.9.9') || url.includes('/releases/latest')) {
            return new Response(
              JSON.stringify({
                tag_name: 'v9.9.9',
                body: null,
                assets: [
                  {
                    name: 'breeze-agent-linux-amd64',
                    browser_download_url: `https://github.com/${REPO}/releases/download/v9.9.9/breeze-agent-linux-amd64`,
                    size: 4096,
                  },
                  {
                    name: 'release-artifact-manifest.json',
                    browser_download_url: `https://github.com/${REPO}/releases/download/v9.9.9/release-artifact-manifest.json`,
                    size: releaseManifest.length,
                  },
                  {
                    name: 'release-artifact-manifest.json.ed25519',
                    browser_download_url: `https://github.com/${REPO}/releases/download/v9.9.9/release-artifact-manifest.json.ed25519`,
                    size: signatureBody.length,
                  },
                ],
              }),
            );
          }
          if (url.endsWith('/release-artifact-manifest.json')) return new Response(releaseManifest);
          if (url.endsWith('/release-artifact-manifest.json.ed25519')) return new Response(new Uint8Array(signatureBody));
          return new Response('not found', { status: 404 });
        }),
      );

    // Source isolation: with only the SELF-HOSTER key configured, a manifest
    // signed by the (still distinct) official key must be rejected.
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = rawPub(selfHosterKey.publicKey);
    stub(officialSig);
    await expect(syncFromGitHub('v9.9.9')).rejects.toThrow(/signature verification failed/);
    expect(dbMocks.insertValues).not.toHaveBeenCalled();

    // Happy path: self-hoster-signed manifest registers, and the stored row is
    // byte-identical to the committed Go fixture — same manifest string, same
    // deterministic Ed25519 signature, same deploy-* key ID.
    stub(selfHosterSig);
    const result = await syncFromGitHub('v9.9.9');
    expect(result.synced).toContain('agent:linux/amd64');

    const fixtureEntry = fixture.entries.find(
      (e) => e.platform === 'linux' && e.arch === 'amd64',
    )!;
    const insertCalls = dbMocks.insertValues.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const insert = insertCalls[0]![0];
    expect(insert.signingKeyId).toBe(fixture.keyId);
    expect(insert.releaseManifest).toBe(fixtureEntry.manifest);
    expect(insert.manifestSignature).toBe(fixtureEntry.signatureB64);
  });
});
