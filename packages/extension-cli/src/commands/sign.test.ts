import { createPublicKey, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import StreamZip from 'node-stream-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseExtensionManifestV1 } from '@breeze/extension-sdk';
import { writeDeterministicZip } from '../artifact/deterministicZip';
import { signingPayload } from '../artifact/integrity';
import { createProgram } from '../cli';
import { packExtension } from './pack';
import { runSign, signArtifact } from './sign';

const VALID_MANIFEST = {
  apiVersion: 'breeze.extensions/v1',
  name: 'acme-widgets',
  version: '1.0.0',
  routeNamespace: 'acme-widgets',
  requires: { breeze: '>=0.1.0 <0.2.0', serverSdk: '^1.0.0', capabilities: [] },
  server: { entry: 'server/index.js' },
  schemaCompatibilityFloor: '1.0.0',
  jobs: [],
  aiTools: [],
};

let sourceDir: string;
let workDir: string;

beforeEach(async () => {
  sourceDir = await mkdtemp(join(tmpdir(), 'breeze-ext-sign-src-'));
  workDir = await mkdtemp(join(tmpdir(), 'breeze-ext-sign-out-'));
});

afterEach(async () => {
  await rm(sourceDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

async function writeFixture(relPath: string, contents: string | object): Promise<void> {
  const fullPath = join(sourceDir, ...relPath.split('/'));
  await mkdir(join(fullPath, '..'), { recursive: true });
  const body = typeof contents === 'string' ? contents : JSON.stringify(contents);
  await writeFile(fullPath, body);
}

async function writeValidFixtureTree(): Promise<void> {
  await writeFixture('manifest.json', VALID_MANIFEST);
  await writeFixture('server/index.js', 'module.exports = () => {};');
  await writeFixture('migrations/0001_init.sql', 'select 1;');
}

async function readZipEntries(archivePath: string): Promise<Record<string, Buffer>> {
  const zip = new StreamZip.async({ file: archivePath });
  try {
    const entries = await zip.entries();
    const out: Record<string, Buffer> = {};
    for (const name of Object.keys(entries)) {
      out[name] = await zip.entryData(name);
    }
    return out;
  } finally {
    await zip.close();
  }
}

function generateEd25519Pem() {
  return generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function generateRsaPem() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

async function packFixture(): Promise<{ artifactPath: string; digest: string }> {
  await writeValidFixtureTree();
  return packExtension({ path: sourceDir, out: join(workDir, 'unsigned.breeze-ext') });
}

describe('signArtifact', () => {
  it('signs an unsigned artifact so the signature member verifies under the matching public key', async () => {
    const packed = await packFixture();
    const { privateKey, publicKey } = generateEd25519Pem();
    const keyPath = join(workDir, 'key.pem');
    await writeFile(keyPath, privateKey);

    const signed = await signArtifact({ artifact: packed.artifactPath, key: keyPath });

    const entries = await readZipEntries(signed.artifactPath);
    const manifest = parseExtensionManifestV1(JSON.parse(entries['manifest.json'].toString('utf8')));
    const payload = signingPayload(manifest, entries['manifest.json'], entries['integrity.json']);

    expect(cryptoVerify(null, payload, createPublicKey(publicKey), entries['signature'])).toBe(true);
  });

  it('fails verification under a different keypair', async () => {
    const packed = await packFixture();
    const { privateKey } = generateEd25519Pem();
    const { publicKey: otherPublicKey } = generateEd25519Pem();
    const keyPath = join(workDir, 'key.pem');
    await writeFile(keyPath, privateKey);

    const signed = await signArtifact({ artifact: packed.artifactPath, key: keyPath });

    const entries = await readZipEntries(signed.artifactPath);
    const manifest = parseExtensionManifestV1(JSON.parse(entries['manifest.json'].toString('utf8')));
    const payload = signingPayload(manifest, entries['manifest.json'], entries['integrity.json']);

    expect(
      cryptoVerify(null, payload, createPublicKey(otherPublicKey), entries['signature']),
    ).toBe(false);
  });

  it('a mutated integrity.json invalidates the signature', async () => {
    const packed = await packFixture();
    const { privateKey, publicKey } = generateEd25519Pem();
    const keyPath = join(workDir, 'key.pem');
    await writeFile(keyPath, privateKey);

    const signed = await signArtifact({ artifact: packed.artifactPath, key: keyPath });
    const entries = await readZipEntries(signed.artifactPath);

    // Tamper with integrity.json bytes but carry over the original signature.
    const tamperedIntegrityBytes = Buffer.concat([entries['integrity.json'], Buffer.from(' ')]);
    const tamperedMembers = Object.entries(entries)
      .filter(([name]) => name !== 'integrity.json')
      .map(([path, bytes]) => ({ path, bytes }));
    tamperedMembers.push({ path: 'integrity.json', bytes: tamperedIntegrityBytes });

    const tamperedPath = join(workDir, 'tampered.breeze-ext');
    await writeDeterministicZip(tamperedMembers, tamperedPath, { sourceDateEpoch: 0 });

    const tamperedEntries = await readZipEntries(tamperedPath);
    const manifest = parseExtensionManifestV1(JSON.parse(tamperedEntries['manifest.json'].toString('utf8')));
    const payload = signingPayload(manifest, tamperedEntries['manifest.json'], tamperedEntries['integrity.json']);

    expect(
      cryptoVerify(null, payload, createPublicKey(publicKey), tamperedEntries['signature']),
    ).toBe(false);
  });

  it('writes the signature member as raw bytes, not parseable JSON', async () => {
    const packed = await packFixture();
    const { privateKey } = generateEd25519Pem();
    const keyPath = join(workDir, 'key.pem');
    await writeFile(keyPath, privateKey);

    const signed = await signArtifact({ artifact: packed.artifactPath, key: keyPath });
    const entries = await readZipEntries(signed.artifactPath);

    expect(entries['signature'].length).toBe(64); // raw Ed25519 signature length
    expect(() => JSON.parse(entries['signature'].toString('utf8'))).toThrow();
  });

  it('rejects a non-Ed25519 (RSA) key', async () => {
    const packed = await packFixture();
    const { privateKey } = generateRsaPem();
    const keyPath = join(workDir, 'rsa-key.pem');
    await writeFile(keyPath, privateKey);

    await expect(
      signArtifact({ artifact: packed.artifactPath, key: keyPath }),
    ).rejects.toThrow(/ed25519/i);
  });

  it('re-signing an already-signed artifact replaces the signature member', async () => {
    const packed = await packFixture();
    const keyA = generateEd25519Pem();
    const keyAPath = join(workDir, 'key-a.pem');
    await writeFile(keyAPath, keyA.privateKey);

    const firstSigned = await signArtifact({ artifact: packed.artifactPath, key: keyAPath });

    const keyB = generateEd25519Pem();
    const keyBPath = join(workDir, 'key-b.pem');
    await writeFile(keyBPath, keyB.privateKey);

    const resigned = await signArtifact({ artifact: firstSigned.artifactPath, key: keyBPath });

    const entries = await readZipEntries(resigned.artifactPath);
    expect(Object.keys(entries).filter((name) => name === 'signature')).toHaveLength(1);

    const manifest = parseExtensionManifestV1(JSON.parse(entries['manifest.json'].toString('utf8')));
    const payload = signingPayload(manifest, entries['manifest.json'], entries['integrity.json']);

    expect(cryptoVerify(null, payload, createPublicKey(keyB.publicKey), entries['signature'])).toBe(true);
    expect(cryptoVerify(null, payload, createPublicKey(keyA.publicKey), entries['signature'])).toBe(false);
    expect(resigned.digest).not.toBe(firstSigned.digest);
  });

  it('prints/returns a digest that differs from the unsigned artifact digest', async () => {
    const packed = await packFixture();
    const { privateKey } = generateEd25519Pem();
    const keyPath = join(workDir, 'key.pem');
    await writeFile(keyPath, privateKey);

    const signed = await signArtifact({ artifact: packed.artifactPath, key: keyPath });

    expect(signed.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(signed.digest).not.toBe(packed.digest);
  });

  it('writes to --out when given, leaving the original artifact untouched', async () => {
    const packed = await packFixture();
    const { privateKey } = generateEd25519Pem();
    const keyPath = join(workDir, 'key.pem');
    await writeFile(keyPath, privateKey);
    const outPath = join(workDir, 'signed.breeze-ext');

    const signed = await signArtifact({ artifact: packed.artifactPath, key: keyPath, out: outPath });

    expect(signed.artifactPath).toBe(outPath);
    const unsignedEntries = await readZipEntries(packed.artifactPath);
    expect(unsignedEntries['signature']).toBeUndefined();
    const signedEntries = await readZipEntries(outPath);
    expect(signedEntries['signature']).toBeDefined();
  });
});

describe('secret hygiene', () => {
  it('never leaks key material into stdout, stderr, or thrown error text on a failed signing run', async () => {
    const packed = await packFixture();
    const { privateKey } = generateEd25519Pem();
    const keyPath = join(workDir, 'key.pem');
    await writeFile(keyPath, privateKey);

    // Fails AFTER the real key has been read and used to sign the payload:
    // SOURCE_DATE_EPOCH is unparseable, which the ZIP writer's epoch
    // resolution rejects synchronously, before any output file is opened.
    const originalEpoch = process.env.SOURCE_DATE_EPOCH;
    process.env.SOURCE_DATE_EPOCH = 'not-a-number';

    const stdout: string[] = [];
    const stderr: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      stdout.push(String(msg));
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      stderr.push(String(msg));
    });

    let thrown: unknown;
    try {
      await runSign({ artifact: packed.artifactPath, key: keyPath });
    } catch (error) {
      thrown = error;
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (originalEpoch === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = originalEpoch;
    }

    logSpy.mockRestore();
    errorSpy.mockRestore();

    expect(thrown).toBeInstanceOf(Error);

    const keyBase64Body = privateKey
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('-----'))
      .join('');
    expect(keyBase64Body.length).toBeGreaterThan(0);

    const haystacks = [
      ...stdout,
      ...stderr,
      (thrown as Error).message,
      (thrown as Error).stack ?? '',
    ];
    for (const haystack of haystacks) {
      expect(haystack).not.toContain(privateKey);
      expect(haystack).not.toContain(keyBase64Body);
      expect(haystack.toLowerCase()).not.toContain('begin private key');
    }
  });
});

describe('breeze-ext sign CLI', () => {
  it('signs via the CLI command form: sign <artifact> --key <path>', async () => {
    const packed = await packFixture();
    const { privateKey, publicKey } = generateEd25519Pem();
    const keyPath = join(workDir, 'key.pem');
    await writeFile(keyPath, privateKey);
    const outPath = join(workDir, 'cli-signed.breeze-ext');

    const program = createProgram();
    program.exitOverride();

    await program.parseAsync([
      'node', 'breeze-ext', 'sign', packed.artifactPath, '--key', keyPath, '--out', outPath,
    ]);

    const entries = await readZipEntries(outPath);
    const manifest = parseExtensionManifestV1(JSON.parse(entries['manifest.json'].toString('utf8')));
    const payload = signingPayload(manifest, entries['manifest.json'], entries['integrity.json']);
    expect(cryptoVerify(null, payload, createPublicKey(publicKey), entries['signature'])).toBe(true);
  });

  it('signs via the CLI command form: sign <artifact> --key-env <VAR>', async () => {
    const packed = await packFixture();
    const { privateKey, publicKey } = generateEd25519Pem();
    process.env.TEST_BREEZE_SIGN_CLI_KEY = privateKey;
    const outPath = join(workDir, 'cli-signed-env.breeze-ext');

    try {
      const program = createProgram();
      program.exitOverride();

      await program.parseAsync([
        'node', 'breeze-ext', 'sign', packed.artifactPath,
        '--key-env', 'TEST_BREEZE_SIGN_CLI_KEY', '--out', outPath,
      ]);

      const entries = await readZipEntries(outPath);
      const manifest = parseExtensionManifestV1(JSON.parse(entries['manifest.json'].toString('utf8')));
      const payload = signingPayload(manifest, entries['manifest.json'], entries['integrity.json']);
      expect(cryptoVerify(null, payload, createPublicKey(publicKey), entries['signature'])).toBe(true);
    } finally {
      delete process.env.TEST_BREEZE_SIGN_CLI_KEY;
    }
  });
});
