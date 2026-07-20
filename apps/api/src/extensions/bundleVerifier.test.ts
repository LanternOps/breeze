import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { parseExtensionManifestV1 } from '@breeze/extension-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtensionSelection } from './config';
import {
  canonicalSigningPayload,
  readBoundedZipDirectory,
  verifyExtensionBundle,
  type TrustedPublisher,
} from './bundleVerifier';

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

interface Fixture {
  path: string;
  selection: ExtensionSelection;
  trust: TrustedPublisher;
  publicKey: KeyObject;
}

interface FixtureOptions {
  extraEntry?: string;
  members?: Record<string, Buffer>;
  tamperMember?: string;
  signWith?: KeyObject;
  manifestOverrides?: Record<string, unknown>;
  /**
   * Rewrite the finished archive bytes before they are hashed and written. The
   * pinned digest is taken from the RESULT, so a post-processed fixture is still
   * a correctly-pinned, correctly-signed bundle whose only defect is whatever
   * this callback introduced.
   */
  postProcessArchive?: (archive: Buffer) => Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const CENTRAL_FILE_HEADER_FIXED_SIZE = 46;

/**
 * Forge a ZIP whose central directory lists `memberName` TWICE.
 *
 * No ordinary ZIP writer emits true duplicate paths, so this cannot be produced
 * through JSZip's API — the bytes have to be edited directly. Rather than
 * hand-rolling a whole archive (which would risk the verifier rejecting it for
 * some unrelated malformation, proving nothing), this takes a VALID signed
 * archive and appends one extra copy of an existing central-directory record,
 * then fixes up the end-of-central-directory record:
 *
 *   • entry counts (both "this disk" and "total") += 1
 *   • central-directory size += the duplicated record's length
 *   • central-directory OFFSET is unchanged — the record is appended at the end
 *     of the existing directory, so where the directory starts does not move.
 *
 * The duplicate record points at the same local file header, so both entries are
 * individually readable and every other structure in the file stays correct.
 * That is exactly the zip-confusion primitive the control exists to stop: a
 * verifier that hashes one instance while an extractor writes the other.
 */
function duplicateCentralDirectoryEntry(archive: Buffer, memberName: string): Buffer {
  let eocd = -1;
  for (let i = archive.length - 22; i >= 0; i -= 1) {
    if (archive.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('fixture: end-of-central-directory record not found');

  const diskEntries = archive.readUInt16LE(eocd + 8);
  const totalEntries = archive.readUInt16LE(eocd + 10);
  const directorySize = archive.readUInt32LE(eocd + 12);
  const directoryOffset = archive.readUInt32LE(eocd + 16);

  let cursor = directoryOffset;
  let record: Buffer | undefined;
  for (let i = 0; i < diskEntries; i += 1) {
    if (archive.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER_SIGNATURE) {
      throw new Error('fixture: malformed central directory record');
    }
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const recordLength = CENTRAL_FILE_HEADER_FIXED_SIZE + nameLength + extraLength + commentLength;
    const name = archive
      .subarray(cursor + CENTRAL_FILE_HEADER_FIXED_SIZE, cursor + CENTRAL_FILE_HEADER_FIXED_SIZE + nameLength)
      .toString('utf8');
    if (name === memberName) {
      record = Buffer.from(archive.subarray(cursor, cursor + recordLength));
    }
    cursor += recordLength;
  }
  if (!record) throw new Error(`fixture: member "${memberName}" not found in the central directory`);

  const eocdCopy = Buffer.from(archive.subarray(eocd));
  eocdCopy.writeUInt16LE(diskEntries + 1, 8);
  eocdCopy.writeUInt16LE(totalEntries + 1, 10);
  eocdCopy.writeUInt32LE(directorySize + record.length, 12);

  return Buffer.concat([archive.subarray(0, directoryOffset + directorySize), record, eocdCopy]);
}

/**
 * Forge a zip-bomb-shaped defect on `memberName`'s central-directory record:
 * declare a small uncompressed `size` (a lie) AND set the streaming
 * data-descriptor flag (general-purpose bit 0x08). That is exactly the shape the
 * real `archiver`-based packer emits — bit 0x08 disables node-stream-zip's own
 * CRC/size guard (`canVerifyCrc` returns false), so the declared size is never
 * checked during inflation. The compressed payload is left untouched, so the
 * member still inflates to its true (larger) size. A verifier that trusts the
 * declared size, or the library's optional guard, would buffer the whole
 * inflation into memory; the bounded reader must abort on actual bytes instead.
 */
function understateMemberSize(archive: Buffer, memberName: string, fakeSize: number): Buffer {
  const out = Buffer.from(archive);
  let eocd = -1;
  for (let i = out.length - 22; i >= 0; i -= 1) {
    if (out.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('fixture: end-of-central-directory record not found');

  const diskEntries = out.readUInt16LE(eocd + 8);
  const directoryOffset = out.readUInt32LE(eocd + 16);
  let cursor = directoryOffset;
  for (let i = 0; i < diskEntries; i += 1) {
    if (out.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER_SIGNATURE) {
      throw new Error('fixture: malformed central directory record');
    }
    const nameLength = out.readUInt16LE(cursor + 28);
    const extraLength = out.readUInt16LE(cursor + 30);
    const commentLength = out.readUInt16LE(cursor + 32);
    const name = out
      .subarray(cursor + CENTRAL_FILE_HEADER_FIXED_SIZE, cursor + CENTRAL_FILE_HEADER_FIXED_SIZE + nameLength)
      .toString('utf8');
    if (name === memberName) {
      // Flags at offset 8: set the data-descriptor bit so the reader's own CRC
      // guard is disabled, matching a real packer's output.
      out.writeUInt16LE(out.readUInt16LE(cursor + 8) | 0x08, cursor + 8);
      // Uncompressed size at offset 24: the under-declared lie.
      out.writeUInt32LE(fakeSize, cursor + 24);
      return out;
    }
    cursor += CENTRAL_FILE_HEADER_FIXED_SIZE + nameLength + extraLength + commentLength;
  }
  throw new Error(`fixture: member "${memberName}" not found in the central directory`);
}

const scratchDirs: string[] = [];

async function makeSignedFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const manifestBytes = Buffer.from(JSON.stringify(manifestObject(options.manifestOverrides)), 'utf8');
  const members: Record<string, Buffer> = options.members ?? {
    'manifest.json': manifestBytes,
    'server/index.cjs': Buffer.from('module.exports = { register() {} };\n', 'utf8'),
  };
  if (!('manifest.json' in members)) {
    members['manifest.json'] = manifestBytes;
  }

  const inventoryMembers: Record<string, { sha256: string; size: number }> = {};
  for (const [name, data] of Object.entries(members)) {
    inventoryMembers[name] = { sha256: sha256Hex(data), size: data.length };
  }
  const integrityBytes = Buffer.from(
    JSON.stringify({ algorithm: 'sha256', members: inventoryMembers }),
    'utf8',
  );

  const manifest = parseExtensionManifestV1(JSON.parse(members['manifest.json'].toString('utf8')));
  const payload = canonicalSigningPayload(manifest, members['manifest.json'], integrityBytes);
  const signature = cryptoSign(null, payload, options.signWith ?? privateKey);

  const zip = new JSZip();
  for (const [name, data] of Object.entries(members)) {
    // tamperMember lets a test corrupt a payload member AFTER its inventory
    // hash was recorded, exercising the per-member integrity check.
    zip.file(name, name === options.tamperMember ? Buffer.concat([data, Buffer.from('X')]) : data);
  }
  zip.file('integrity.json', integrityBytes);
  zip.file('signature', signature);
  if (options.extraEntry) {
    zip.file(options.extraEntry, Buffer.from('malicious', 'utf8'));
  }

  const generated = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const buf = options.postProcessArchive ? options.postProcessArchive(generated) : generated;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'breeze-ext-bundle-'));
  scratchDirs.push(dir);
  const archivePath = path.join(dir, 'demo.breeze-ext');
  writeFileSync(archivePath, buf);

  const artifactDigest = `sha256:${sha256Hex(buf)}` as `sha256:${string}`;
  const selection: ExtensionSelection = {
    name: 'demo-ext',
    uri: `file:${archivePath}`,
    version: '1.2.3',
    digest: artifactDigest,
    publisher: 'acme',
    required: false,
    rollout: 'rolling',
  };
  const trust: TrustedPublisher = { publisher: 'acme', publicKey };
  return { path: archivePath, selection, trust, publicKey };
}

describe('verifyExtensionBundle', () => {
  afterEach(() => {
    process.env.NODE_ENV = process.env.NODE_ENV;
  });

  it('accepts a valid signed bundle and returns a frozen verified result', async () => {
    const fixture = await makeSignedFixture();
    const verified = await verifyExtensionBundle(fixture.path, fixture.selection, fixture.trust);

    expect(verified.manifest.name).toBe('demo-ext');
    expect(verified.manifest.version).toBe('1.2.3');
    expect(verified.artifactDigest).toBe(fixture.selection.digest);
    expect([...verified.files.keys()].sort()).toEqual(['manifest.json', 'server/index.cjs']);
    expect(verified.files.has('integrity.json')).toBe(false);
    expect(verified.files.has('signature')).toBe(false);
    expect(Object.isFrozen(verified)).toBe(true);
  });

  it.each(['../escape', '/absolute', 'server/addon.node'])('rejects unsafe member %s', async (entry) => {
    const archive = await makeSignedFixture({ extraEntry: entry });
    await expect(
      verifyExtensionBundle(archive.path, archive.selection, archive.trust),
    ).rejects.toThrow();
  });

  it('rejects a valid signature when the pinned artifact digest differs', async () => {
    const archive = await makeSignedFixture();
    await expect(
      verifyExtensionBundle(
        archive.path,
        { ...archive.selection, digest: `sha256:${'0'.repeat(64)}` },
        archive.trust,
      ),
    ).rejects.toThrow(/digest/);
  });

  it('rejects a signature made by an untrusted key', async () => {
    const archive = await makeSignedFixture();
    const stranger = generateKeyPairSync('ed25519').publicKey;
    await expect(
      verifyExtensionBundle(archive.path, archive.selection, { publisher: 'acme', publicKey: stranger }),
    ).rejects.toThrow(/signature/i);
  });

  it('rejects a tampered payload member whose hash no longer matches the inventory', async () => {
    const archive = await makeSignedFixture({ tamperMember: 'server/index.cjs' });
    await expect(
      verifyExtensionBundle(archive.path, archive.selection, archive.trust),
    ).rejects.toThrow(/integrity/i);
  });

  it('rejects a selected version that does not match the verified manifest', async () => {
    const archive = await makeSignedFixture();
    await expect(
      verifyExtensionBundle(archive.path, { ...archive.selection, version: '9.9.9' }, archive.trust),
    ).rejects.toThrow(/version/i);
  });

  // A duplicate member path is a verification-BYPASS primitive, not a mere
  // malformation: the verifier hashes whichever instance its reader keeps while
  // an extractor (or any other consumer with different dedup semantics) may
  // write the other one. The signed inventory would then cover bytes that never
  // reach disk. This bundle is signed, pinned and otherwise completely valid —
  // the duplicate path is the ONLY defect — so a pass here proves the control
  // itself fires rather than some incidental check.
  it('rejects a signed bundle whose central directory lists a member path twice', async () => {
    const fixture = await makeSignedFixture({
      postProcessArchive: (archive) => duplicateCentralDirectoryEntry(archive, 'server/index.cjs'),
    });

    await expect(
      verifyExtensionBundle(fixture.path, fixture.selection, fixture.trust),
    ).rejects.toThrow(/duplicate member paths/i);
  });

  it('rejects when the trusted publisher does not match the selection', async () => {
    const archive = await makeSignedFixture();
    await expect(
      verifyExtensionBundle(archive.path, archive.selection, { ...archive.trust, publisher: 'other' }),
    ).rejects.toThrow(/publisher/i);
  });
});

describe('readBoundedZipDirectory', () => {
  afterEach(() => {
    // scratch dirs are left in the OS temp dir; the OS reclaims them.
  });

  // The check lives in this reader, so cover it at the level that owns it too:
  // the central directory declares N+1 entries while the deduped map holds N.
  it('rejects an archive whose central directory declares a duplicate member path', async () => {
    const fixture = await makeSignedFixture({
      postProcessArchive: (archive) => duplicateCentralDirectoryEntry(archive, 'manifest.json'),
    });

    await expect(readBoundedZipDirectory(fixture.path)).rejects.toThrow(/duplicate member paths/i);
  });

  it('rejects an archive whose member count exceeds the limit', async () => {
    const zip = new JSZip();
    for (let i = 0; i < 12; i += 1) {
      zip.file(`f${i}.txt`, 'x');
    }
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const dir = mkdtempSync(path.join(os.tmpdir(), 'breeze-ext-count-'));
    const archivePath = path.join(dir, 'many.breeze-ext');
    writeFileSync(archivePath, buf);

    await expect(
      readBoundedZipDirectory(archivePath, { maxMembers: 10, maxMemberBytes: 1024, maxTotalBytes: 1024 }),
    ).rejects.toThrow(/member/i);
  });

  it('rejects a member larger than the per-member size limit', async () => {
    const zip = new JSZip();
    zip.file('big.txt', Buffer.alloc(256, 0x61));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const dir = mkdtempSync(path.join(os.tmpdir(), 'breeze-ext-size-'));
    const archivePath = path.join(dir, 'big.breeze-ext');
    writeFileSync(archivePath, buf);

    await expect(
      readBoundedZipDirectory(archivePath, { maxMembers: 10, maxMemberBytes: 64, maxTotalBytes: 1024 }),
    ).rejects.toThrow(/size|exceed/i);
  });

  it('rejects when total extracted payload exceeds the total limit', async () => {
    const zip = new JSZip();
    zip.file('a.txt', Buffer.alloc(80, 0x61));
    zip.file('b.txt', Buffer.alloc(80, 0x62));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const dir = mkdtempSync(path.join(os.tmpdir(), 'breeze-ext-total-'));
    const archivePath = path.join(dir, 'total.breeze-ext');
    writeFileSync(archivePath, buf);

    await expect(
      readBoundedZipDirectory(archivePath, { maxMembers: 10, maxMemberBytes: 128, maxTotalBytes: 100 }),
    ).rejects.toThrow(/total|exceed/i);
  });

  // ZIP BOMB. The uncompressed size in the central directory is
  // attacker-controlled, and a real packer sets bit 0x08 which turns OFF the
  // reader's own size guard — so the only defense against a member that declares
  // a tiny size but inflates to gigabytes is the reader bounding ACTUAL
  // decompressed bytes. This fixture inflates to 4096 bytes while declaring 8,
  // with bit 0x08 set; a reader that trusts the declared size would sail past
  // the 1024-byte per-member limit and buffer the whole thing. A regression that
  // reverts to trusting the declared size (or to entryData) would fail here.
  it('bounds actual inflated bytes even when the central directory under-declares size', async () => {
    const fixture = await makeSignedFixture({
      members: {
        'manifest.json': Buffer.from(JSON.stringify(manifestObject()), 'utf8'),
        'server/index.cjs': Buffer.alloc(4096, 0x61),
      },
      postProcessArchive: (archive) => understateMemberSize(archive, 'server/index.cjs', 8),
    });

    await expect(
      readBoundedZipDirectory(fixture.path, {
        maxMembers: 10,
        maxMemberBytes: 1024,
        maxTotalBytes: 100_000,
      }),
    ).rejects.toThrow(/inflates beyond|size limit/i);
  });

  // Symlink members are an archive-escape vector (a materialized link reads or
  // writes outside the extraction root, or import() follows it). The control
  // lives in isSymlinkEntry; no ordinary writer emits a symlink member through
  // its API, so the S_IFLNK external-attribute bits must be forged directly.
  it('rejects an archive member flagged as a symlink', async () => {
    const zip = new JSZip();
    zip.file('server/link', 'target/path', {
      unixPermissions: 0o120777, // S_IFLNK | 0777
    });
    const buf = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' });
    const dir = mkdtempSync(path.join(os.tmpdir(), 'breeze-ext-symlink-'));
    const archivePath = path.join(dir, 'symlink.breeze-ext');
    writeFileSync(archivePath, buf);

    await expect(readBoundedZipDirectory(archivePath)).rejects.toThrow(/symlink/i);
  });
});
