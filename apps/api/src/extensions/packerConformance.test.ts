import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import StreamZip from 'node-stream-zip';
import { afterEach, describe, expect, it } from 'vitest';
// Deliberately NOT `@breeze/extension-cli` package-root imports for the
// command internals: the package's `exports` map only publishes `"."`
// (`src/index.ts`, which re-exports only the `run*` CLI entry points), so
// `packExtension`/`signArtifact`/`signingPayload` — none of which are
// re-exported — are reached via a plain relative filesystem import into the
// package's source, same as any other in-repo cross-package test import.
// This does NOT create a runtime dependency of the CLI package on apps/api;
// the arrow still points app -> package, one file, test-only.
import { packExtension, signArtifact, signingPayload } from '@breeze/extension-cli';
import type { ExtensionSelection } from './config';
import {
  canonicalSigningPayload,
  verifyExtensionBundle,
  type TrustedPublisher,
} from './bundleVerifier';

/**
 * Task 6 (runtime extension platform, issue #2619) — the load-bearing
 * conformance test. Everything here packs and signs a REAL fixture with the
 * REAL `@breeze/extension-cli`, then runs the REAL, frozen
 * `verifyExtensionBundle`. No in-process fixture builder stands in for the
 * packer or the signer: if the CLI's wire format ever drifts from what the
 * verifier expects, this file — not a hand-rolled fixture — is what breaks.
 */

function manifestObject(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: 'breeze.extensions/v1',
    name: 'demo-ext',
    version: '1.2.3',
    routeNamespace: 'demo-ext',
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
  };
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function digestOf(data: Buffer): `sha256:${string}` {
  return `sha256:${sha256Hex(data)}`;
}

const scratchDirs: string[] = [];

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** Write a minimal, SDK-valid extension source tree that `collectPayload` accepts. */
async function writeSourceTree(dir: string, manifestOverrides: Record<string, unknown> = {}): Promise<void> {
  await mkdir(join(dir, 'server'), { recursive: true });
  await mkdir(join(dir, 'migrations'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifestObject(manifestOverrides)));
  await writeFile(join(dir, 'server/index.cjs'), 'module.exports = { register() {} };\n');
  await writeFile(join(dir, 'migrations/0001_init.sql'), 'select 1;\n');
}

interface SignedFixture {
  /** Path to the packed+signed `.breeze-ext` artifact. Never mutated by a test. */
  artifactPath: string;
  /** The digest `signArtifact` returned for `artifactPath` — the SIGNED digest. */
  digest: `sha256:${string}`;
  publicKey: KeyObject;
  privateKey: KeyObject;
  selection: ExtensionSelection;
  trust: TrustedPublisher;
}

/**
 * Pack and sign a fresh fixture with the real CLI: a real source tree on
 * disk, a real generated Ed25519 keypair (private key written to a temp PEM
 * file and handed to `signArtifact` via its `key` option, exactly as
 * `breeze-ext sign --key <path>` would), and the real `packExtension` /
 * `signArtifact` pipeline. No key material is committed; everything here
 * lives under a per-test temp directory cleaned up in `afterEach`.
 */
async function buildSignedFixture(manifestOverrides: Record<string, unknown> = {}): Promise<SignedFixture> {
  const sourceDir = await scratchDir('breeze-ext-conformance-src-');
  const outDir = await scratchDir('breeze-ext-conformance-out-');
  const keyDir = await scratchDir('breeze-ext-conformance-key-');

  await writeSourceTree(sourceDir, manifestOverrides);

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyPath = join(keyDir, 'signing-key.pem');
  await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  const packResult = await packExtension({
    path: sourceDir,
    out: join(outDir, 'unsigned.breeze-ext'),
    sourceDateEpoch: 0,
  });
  const signResult = await signArtifact({
    artifact: packResult.artifactPath,
    key: keyPath,
    out: join(outDir, 'signed.breeze-ext'),
  });

  const digest = signResult.digest as `sha256:${string}`;
  const selection: ExtensionSelection = {
    name: 'demo-ext',
    uri: 'file://local',
    version: '1.2.3',
    digest,
    publisher: 'acme',
    required: false,
    rollout: 'rolling',
  };
  const trust: TrustedPublisher = { publisher: 'acme', publicKey };

  return { artifactPath: signResult.artifactPath, digest, publicKey, privateKey, selection, trust };
}

/**
 * Load a signed artifact into an in-memory JSZip, let `mutate` edit it, and
 * write the result to a NEW path (the original, valid artifact is left
 * untouched on disk so a test can verify it too, as the "without the
 * mutation" control). Returns the mutated path and the digest of the
 * mutated bytes — pinning THAT digest is what isolates each negative test
 * to the single control it targets, rather than tripping the (separately
 * tested) pinned-digest mismatch check.
 */
async function mutateArtifact(
  sourcePath: string,
  mutate: (zip: JSZip) => void | Promise<void>,
): Promise<{ path: string; digest: `sha256:${string}` }> {
  const original = await readFile(sourcePath);
  const zip = await JSZip.loadAsync(original);
  await mutate(zip);
  const mutatedBytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  const outDir = await scratchDir('breeze-ext-conformance-mutated-');
  const mutatedPath = join(outDir, 'mutated.breeze-ext');
  await writeFile(mutatedPath, mutatedBytes);

  return { path: mutatedPath, digest: digestOf(mutatedBytes) };
}

async function readZipMember(archivePath: string, member: string): Promise<Buffer> {
  const zip = new StreamZip.async({ file: archivePath });
  try {
    return await zip.entryData(member);
  } finally {
    await zip.close();
  }
}

async function listZipMembers(archivePath: string): Promise<string[]> {
  const zip = new StreamZip.async({ file: archivePath });
  try {
    const entries = await zip.entries();
    return Object.values(entries)
      .filter((entry) => !entry.isDirectory)
      .map((entry) => entry.name);
  } finally {
    await zip.close();
  }
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('packer/signer output verifies against the frozen verifier', () => {
  describe('positive case', () => {
    it('resolves for a real packed+signed artifact, matching what the packer/signer produced', async () => {
      const fixture = await buildSignedFixture();

      const bundle = await verifyExtensionBundle(fixture.artifactPath, fixture.selection, fixture.trust);

      expect(bundle.manifest.name).toBe('demo-ext');
      expect(bundle.manifest.version).toBe('1.2.3');
      expect(bundle.artifactDigest).toBe(fixture.digest);
      expect(Object.isFrozen(bundle)).toBe(true);

      // `bundle.files` must be exactly the non-reserved members the packer
      // actually wrote to the archive -- cross-checked against the archive
      // itself, not against a hand-maintained expected list.
      const actualMembers = await listZipMembers(fixture.artifactPath);
      const expectedFiles = actualMembers.filter((name) => name !== 'integrity.json' && name !== 'signature');
      expect([...bundle.files.keys()].sort()).toEqual(expectedFiles.sort());
      expect(expectedFiles.sort()).toEqual(['manifest.json', 'migrations/0001_init.sql', 'server/index.cjs']);

      for (const [name, info] of bundle.files) {
        const bytes = await readZipMember(fixture.artifactPath, name);
        expect(info.sha256).toBe(sha256Hex(bytes));
        expect(info.uncompressedSize).toBe(bytes.length);
      }
    });

    it('produces a signingPayload byte-identical to the verifier\'s canonicalSigningPayload (live drift guard)', async () => {
      const fixture = await buildSignedFixture();

      const manifestBytes = await readZipMember(fixture.artifactPath, 'manifest.json');
      const integrityBytes = await readZipMember(fixture.artifactPath, 'integrity.json');
      const bundle = await verifyExtensionBundle(fixture.artifactPath, fixture.selection, fixture.trust);

      const cliPayload = signingPayload(bundle.manifest, manifestBytes, integrityBytes);
      const verifierPayload = canonicalSigningPayload(bundle.manifest, manifestBytes, integrityBytes);

      expect(cliPayload.equals(verifierPayload)).toBe(true);
    });
  });

  describe('negative cases (each must reject, and each is proven load-bearing)', () => {
    it('rejects a payload member mutated after signing', async () => {
      const fixture = await buildSignedFixture();

      // Control: the artifact as the CLI produced it, untouched, verifies fine.
      await expect(
        verifyExtensionBundle(fixture.artifactPath, fixture.selection, fixture.trust),
      ).resolves.toBeDefined();

      const mutated = await mutateArtifact(fixture.artifactPath, (zip) => {
        zip.file('server/index.cjs', 'module.exports = { register() { /* tampered */ } };\n');
      });
      const mutatedSelection: ExtensionSelection = { ...fixture.selection, digest: mutated.digest };

      // With ONLY the payload byte mutation applied (pinned digest updated to
      // match, so the digest check -- covered separately below -- can't be
      // what's catching this), rejection must come from the per-member
      // integrity check.
      await expect(
        verifyExtensionBundle(mutated.path, mutatedSelection, fixture.trust),
      ).rejects.toThrow(/integrity check/i);
    });

    it('rejects a signature made by a keypair the trust config does not list', async () => {
      const fixture = await buildSignedFixture();

      // Control: the real signer's public key verifies the real artifact.
      await expect(
        verifyExtensionBundle(fixture.artifactPath, fixture.selection, fixture.trust),
      ).resolves.toBeDefined();

      const stranger = generateKeyPairSync('ed25519').publicKey;
      const strangerTrust: TrustedPublisher = { publisher: 'acme', publicKey: stranger };

      await expect(
        verifyExtensionBundle(fixture.artifactPath, fixture.selection, strangerTrust),
      ).rejects.toThrow(/signature/i);
    });

    it('rejects an extra member added to the archive after signing (not in the inventory)', async () => {
      const fixture = await buildSignedFixture();

      await expect(
        verifyExtensionBundle(fixture.artifactPath, fixture.selection, fixture.trust),
      ).resolves.toBeDefined();

      const mutated = await mutateArtifact(fixture.artifactPath, (zip) => {
        zip.file('extra/not-in-inventory.txt', 'malicious payload\n');
      });
      const mutatedSelection: ExtensionSelection = { ...fixture.selection, digest: mutated.digest };

      await expect(
        verifyExtensionBundle(mutated.path, mutatedSelection, fixture.trust),
      ).rejects.toThrow(/not covered by the signed integrity inventory/i);
    });

    it('rejects an inventoried member deleted from the archive', async () => {
      const fixture = await buildSignedFixture();

      await expect(
        verifyExtensionBundle(fixture.artifactPath, fixture.selection, fixture.trust),
      ).resolves.toBeDefined();

      const mutated = await mutateArtifact(fixture.artifactPath, (zip) => {
        zip.remove('migrations/0001_init.sql');
      });
      const mutatedSelection: ExtensionSelection = { ...fixture.selection, digest: mutated.digest };

      await expect(
        verifyExtensionBundle(mutated.path, mutatedSelection, fixture.trust),
      ).rejects.toThrow(/missing from the archive/i);
    });

    it('rejects integrity.json mutated after signing', async () => {
      const fixture = await buildSignedFixture();

      await expect(
        verifyExtensionBundle(fixture.artifactPath, fixture.selection, fixture.trust),
      ).resolves.toBeDefined();

      const mutated = await mutateArtifact(fixture.artifactPath, async (zip) => {
        const entry = zip.file('integrity.json');
        if (!entry) throw new Error('fixture is missing integrity.json');
        const raw = JSON.parse(await entry.async('string'));
        // Corrupt a real, present member's recorded size -- still valid JSON,
        // still schema-valid -- so the ONLY defect is the signed
        // integrity.json no longer matching what was actually signed.
        raw.members['server/index.cjs'].size += 1;
        zip.file('integrity.json', JSON.stringify(raw));
      });
      const mutatedSelection: ExtensionSelection = { ...fixture.selection, digest: mutated.digest };

      // integrity.json's hash is bound into the signed payload, so mutating it
      // invalidates the Ed25519 signature -- rejection surfaces as a signature
      // failure, not a separate "integrity.json changed" check.
      await expect(
        verifyExtensionBundle(mutated.path, mutatedSelection, fixture.trust),
      ).rejects.toThrow(/signature/i);
    });

    it('rejects a reserved member ("signature") added to the integrity inventory', async () => {
      const fixture = await buildSignedFixture();

      await expect(
        verifyExtensionBundle(fixture.artifactPath, fixture.selection, fixture.trust),
      ).resolves.toBeDefined();

      const mutated = await mutateArtifact(fixture.artifactPath, async (zip) => {
        const entry = zip.file('integrity.json');
        if (!entry) throw new Error('fixture is missing integrity.json');
        const raw = JSON.parse(await entry.async('string'));
        raw.members.signature = { sha256: '0'.repeat(64), size: 64 };
        zip.file('integrity.json', JSON.stringify(raw));
      });
      const mutatedSelection: ExtensionSelection = { ...fixture.selection, digest: mutated.digest };

      // This is parsed and rejected before signature verification is even
      // attempted (a mutated integrity.json also breaks the signature, but
      // that is a DIFFERENT control -- this assertion's message pins the
      // rejection to the reserved-member check specifically).
      await expect(
        verifyExtensionBundle(mutated.path, mutatedSelection, fixture.trust),
      ).rejects.toThrow(/reserved member/i);
    });

    it('rejects when the pinned digest does not match the artifact', async () => {
      const fixture = await buildSignedFixture();

      await expect(
        verifyExtensionBundle(fixture.artifactPath, fixture.selection, fixture.trust),
      ).resolves.toBeDefined();

      const wrongDigestSelection: ExtensionSelection = {
        ...fixture.selection,
        digest: `sha256:${'0'.repeat(64)}`,
      };

      await expect(
        verifyExtensionBundle(fixture.artifactPath, wrongDigestSelection, fixture.trust),
      ).rejects.toThrow(/digest/i);
    });

    it('rejects a selection.version that disagrees with the manifest', async () => {
      const fixture = await buildSignedFixture();

      await expect(
        verifyExtensionBundle(fixture.artifactPath, fixture.selection, fixture.trust),
      ).resolves.toBeDefined();

      const wrongVersionSelection: ExtensionSelection = { ...fixture.selection, version: '9.9.9' };

      await expect(
        verifyExtensionBundle(fixture.artifactPath, wrongVersionSelection, fixture.trust),
      ).rejects.toThrow(/version/i);
    });
  });
});
