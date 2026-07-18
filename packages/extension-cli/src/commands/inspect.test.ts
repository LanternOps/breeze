import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import StreamZip from 'node-stream-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../cli';
import { packExtension } from './pack';
import { signArtifact } from './sign';
import { inspectArtifact, runInspect } from './inspect';
import { writeDeterministicZip } from '../artifact/deterministicZip';

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
  sourceDir = await mkdtemp(join(tmpdir(), 'breeze-ext-inspect-src-'));
  workDir = await mkdtemp(join(tmpdir(), 'breeze-ext-inspect-out-'));
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
  await writeFixture('migrations/0002_add_widgets.sql', 'select 2;');
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

async function packFixture(): Promise<{ artifactPath: string; digest: string }> {
  await writeValidFixtureTree();
  return packExtension({ path: sourceDir, out: join(workDir, 'unsigned.breeze-ext') });
}

async function packAndSignFixture(): Promise<{
  artifactPath: string;
  digest: string;
  publicKeyPath: string;
  privateKeyPath: string;
}> {
  const packed = await packFixture();
  const { privateKey, publicKey } = generateEd25519Pem();
  const privateKeyPath = join(workDir, 'signing-key.pem');
  const publicKeyPath = join(workDir, 'signing-key.pub.pem');
  await writeFile(privateKeyPath, privateKey);
  await writeFile(publicKeyPath, publicKey);

  const signed = await signArtifact({ artifact: packed.artifactPath, key: privateKeyPath });
  return { artifactPath: signed.artifactPath, digest: signed.digest, publicKeyPath, privateKeyPath };
}

describe('inspectArtifact', () => {
  it('reports digest, manifest identity, unverified signature, valid inventory, and the migration list with no key', async () => {
    const packed = await packFixture();

    const result = await inspectArtifact({ artifact: packed.artifactPath });

    expect(result.digest).toBe(packed.digest);
    expect(result.manifest).toEqual({
      name: 'acme-widgets',
      version: '1.0.0',
      apiVersion: 'breeze.extensions/v1',
    });
    expect(result.signature).toBe('unverified');
    expect(result.integrity).toEqual({ valid: true, findings: [] });
    expect(result.migrations).toEqual(['0001_init.sql', '0002_add_widgets.sql']);
  });

  it('reports a valid signature when the matching public key is supplied', async () => {
    const { artifactPath, publicKeyPath } = await packAndSignFixture();

    const result = await inspectArtifact({ artifact: artifactPath, publicKey: publicKeyPath });

    expect(result.signature).toBe('valid');
    expect(result.integrity.valid).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('reports an invalid signature under a mismatched public key', async () => {
    const { artifactPath } = await packAndSignFixture();
    const { publicKey: otherPublicKey } = generateEd25519Pem();
    const otherPublicKeyPath = join(workDir, 'other-key.pub.pem');
    await writeFile(otherPublicKeyPath, otherPublicKey);

    const result = await inspectArtifact({ artifact: artifactPath, publicKey: otherPublicKeyPath });

    expect(result.signature).toBe('invalid');
    expect(result.ok).toBe(false);
  });

  it('reports "missing" signature status when a public key is given but the artifact is unsigned', async () => {
    const packed = await packFixture();
    const { publicKey } = generateEd25519Pem();
    const publicKeyPath = join(workDir, 'key.pub.pem');
    await writeFile(publicKeyPath, publicKey);

    const result = await inspectArtifact({ artifact: packed.artifactPath, publicKey: publicKeyPath });

    expect(result.signature).toBe('missing');
    expect(result.ok).toBe(false);
  });

  it('flags a tampered member with the stable "integrity_mismatch" code', async () => {
    const packed = await packFixture();
    const entries = await readZipEntries(packed.artifactPath);

    const tamperedMembers = Object.entries(entries)
      .filter(([name]) => name !== 'server/index.js')
      .map(([path, bytes]) => ({ path, bytes }));
    tamperedMembers.push({
      path: 'server/index.js',
      bytes: Buffer.concat([entries['server/index.js'], Buffer.from('// tampered')]),
    });

    const tamperedPath = join(workDir, 'tampered.breeze-ext');
    await writeDeterministicZip(tamperedMembers, tamperedPath, { sourceDateEpoch: 0 });

    const result = await inspectArtifact({ artifact: tamperedPath });

    expect(result.integrity.valid).toBe(false);
    expect(result.integrity.findings).toContainEqual({
      code: 'integrity_mismatch',
      path: 'server/index.js',
      reason: 'digest_mismatch',
    });
    expect(result.ok).toBe(false);
  });

  it('flags a member added to the archive after packing as "missing_from_inventory"', async () => {
    const packed = await packFixture();
    const entries = await readZipEntries(packed.artifactPath);

    const members = Object.entries(entries).map(([path, bytes]) => ({ path, bytes }));
    members.push({ path: 'server/extra.js', bytes: Buffer.from('module.exports = {};') });

    const tamperedPath = join(workDir, 'extra-member.breeze-ext');
    await writeDeterministicZip(members, tamperedPath, { sourceDateEpoch: 0 });

    const result = await inspectArtifact({ artifact: tamperedPath });

    expect(result.integrity.valid).toBe(false);
    expect(result.integrity.findings).toContainEqual({
      code: 'integrity_mismatch',
      path: 'server/extra.js',
      reason: 'missing_from_inventory',
    });
  });

  it('flags a member removed from the archive after packing as "missing_from_archive"', async () => {
    const packed = await packFixture();
    const entries = await readZipEntries(packed.artifactPath);

    const members = Object.entries(entries)
      .filter(([name]) => name !== 'migrations/0002_add_widgets.sql')
      .map(([path, bytes]) => ({ path, bytes }));

    const tamperedPath = join(workDir, 'missing-member.breeze-ext');
    await writeDeterministicZip(members, tamperedPath, { sourceDateEpoch: 0 });

    const result = await inspectArtifact({ artifact: tamperedPath });

    expect(result.integrity.valid).toBe(false);
    expect(result.integrity.findings).toContainEqual({
      code: 'integrity_mismatch',
      path: 'migrations/0002_add_widgets.sql',
      reason: 'missing_from_archive',
    });
  });

  it('the whole-artifact digest is sha256 of the actual file bytes', async () => {
    const packed = await packFixture();
    const fileBytes = await readFile(packed.artifactPath);
    const expected = `sha256:${createHash('sha256').update(fileBytes).digest('hex')}`;

    const result = await inspectArtifact({ artifact: packed.artifactPath });

    expect(result.digest).toBe(expected);
  });
});

describe('runInspect exit codes', () => {
  it('leaves process.exitCode unset (zero) on a clean, unsigned artifact', async () => {
    const packed = await packFixture();
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runInspect({ artifact: packed.artifactPath, json: true });
      expect(process.exitCode).toBeUndefined();
    } finally {
      logSpy.mockRestore();
      process.exitCode = originalExitCode;
    }
  });

  it('leaves process.exitCode unset (zero) on a clean, validly-signed artifact', async () => {
    const { artifactPath, publicKeyPath } = await packAndSignFixture();
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runInspect({ artifact: artifactPath, json: true, publicKey: publicKeyPath });
      expect(process.exitCode).toBeUndefined();
    } finally {
      logSpy.mockRestore();
      process.exitCode = originalExitCode;
    }
  });

  it('sets a nonzero process.exitCode on an integrity mismatch', async () => {
    const packed = await packFixture();
    const entries = await readZipEntries(packed.artifactPath);
    const tamperedMembers = Object.entries(entries)
      .filter(([name]) => name !== 'server/index.js')
      .map(([path, bytes]) => ({ path, bytes }));
    tamperedMembers.push({
      path: 'server/index.js',
      bytes: Buffer.concat([entries['server/index.js'], Buffer.from('// tampered')]),
    });
    const tamperedPath = join(workDir, 'tampered.breeze-ext');
    await writeDeterministicZip(tamperedMembers, tamperedPath, { sourceDateEpoch: 0 });

    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runInspect({ artifact: tamperedPath, json: true });
      expect(process.exitCode).toBeTruthy();
      expect(process.exitCode).not.toBe(0);
    } finally {
      logSpy.mockRestore();
      process.exitCode = originalExitCode;
    }
  });

  it('sets a nonzero process.exitCode when signature verification fails', async () => {
    const { artifactPath } = await packAndSignFixture();
    const { publicKey: otherPublicKey } = generateEd25519Pem();
    const otherPublicKeyPath = join(workDir, 'other-key.pub.pem');
    await writeFile(otherPublicKeyPath, otherPublicKey);

    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runInspect({ artifact: artifactPath, json: true, publicKey: otherPublicKeyPath });
      expect(process.exitCode).toBeTruthy();
      expect(process.exitCode).not.toBe(0);
    } finally {
      logSpy.mockRestore();
      process.exitCode = originalExitCode;
    }
  });
});

// NOTE: capture printed lines into a local array from WITHIN the mock
// implementation, rather than reading `spy.mock.calls` after `mockRestore()`
// -- Vitest's `mockRestore()` also clears recorded call history (like
// `mockReset()`), so anything read off the spy after restoring is always
// empty. `sign.test.ts`'s "never leaks key material" test uses this same
// side-channel-array pattern for the identical reason.
function captureConsoleLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
    lines.push(String(msg));
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('runInspect --json output', () => {
  it('prints a single JSON document with the expected fields', async () => {
    const { artifactPath, publicKeyPath } = await packAndSignFixture();
    const { lines, restore } = captureConsoleLog();

    try {
      await runInspect({ artifact: artifactPath, json: true, publicKey: publicKeyPath });
    } finally {
      restore();
    }

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      manifest: { name: 'acme-widgets', version: '1.0.0', apiVersion: 'breeze.extensions/v1' },
      signature: 'valid',
      integrity: { valid: true, findings: [] },
      migrations: ['0001_init.sql', '0002_add_widgets.sql'],
    });
  });
});

describe('runInspect human output hygiene', () => {
  it('contains no absolute checkout paths, environment data, or key material', async () => {
    const { artifactPath, privateKeyPath, publicKeyPath } = await packAndSignFixture();
    const privateKeyPem = await readFile(privateKeyPath, 'utf8');
    const { lines, restore } = captureConsoleLog();

    try {
      await runInspect({ artifact: artifactPath, publicKey: publicKeyPath });
    } finally {
      restore();
    }

    expect(lines.length).toBeGreaterThan(0);
    const output = lines.join('\n');

    // No absolute checkout paths: neither the artifact path, the source
    // fixture path, nor the CWD workDir/sourceDir should ever be echoed.
    expect(output).not.toContain(artifactPath);
    expect(output).not.toContain(sourceDir);
    expect(output).not.toContain(workDir);
    expect(output).not.toContain(process.cwd());

    // No key material.
    const keyBase64Body = privateKeyPem
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('-----'))
      .join('');
    expect(output).not.toContain(privateKeyPem);
    expect(output).not.toContain(keyBase64Body);
    expect(output.toLowerCase()).not.toContain('begin private key');

    // No raw environment dumps.
    expect(output).not.toContain('PATH=');
    expect(output).not.toMatch(/HOME=\//);
  });
});

describe('breeze-ext inspect CLI', () => {
  it('inspects via the CLI command form: inspect <artifact> --json', async () => {
    const packed = await packFixture();
    const { lines, restore } = captureConsoleLog();

    const program = createProgram();
    program.exitOverride();

    try {
      await program.parseAsync(['node', 'breeze-ext', 'inspect', packed.artifactPath, '--json']);
    } finally {
      restore();
    }

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.manifest.name).toBe('acme-widgets');
  });

  it('accepts --public-key on the CLI and verifies the signature', async () => {
    const { artifactPath, publicKeyPath } = await packAndSignFixture();
    const { lines, restore } = captureConsoleLog();

    const program = createProgram();
    program.exitOverride();

    try {
      await program.parseAsync([
        'node', 'breeze-ext', 'inspect', artifactPath, '--json', '--public-key', publicKeyPath,
      ]);
    } finally {
      restore();
    }

    const parsed = JSON.parse(lines[0]);
    expect(parsed.signature).toBe('valid');
  });
});
