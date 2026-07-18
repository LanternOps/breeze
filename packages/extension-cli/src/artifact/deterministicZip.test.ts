import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeDeterministicZip, type DeterministicZipMember } from './deterministicZip';

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

let workDir: string;
let counter = 0;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'breeze-ext-zip-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function destinationPath(): string {
  counter += 1;
  return join(workDir, `out-${counter}.zip`);
}

async function packToBuffer(
  members: DeterministicZipMember[],
  options: { sourceDateEpoch: number },
): Promise<Buffer> {
  const destination = destinationPath();
  await writeDeterministicZip(members, destination, options);
  return readFile(destination);
}

const MEMBERS: DeterministicZipMember[] = [
  { path: 'manifest.json', bytes: Buffer.from('{"name":"acme-widgets"}') },
  { path: 'server/index.js', bytes: Buffer.from('module.exports = () => {};') },
  { path: 'assets/logo.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) },
];

describe('writeDeterministicZip: determinism', () => {
  it('packs identical inputs to identical bytes', async () => {
    const first = await packToBuffer(MEMBERS, { sourceDateEpoch: 0 });
    const second = await packToBuffer(MEMBERS, { sourceDateEpoch: 0 });
    expect(sha256(first)).toBe(sha256(second));
  });

  it('is insensitive to input member order', async () => {
    const forward = await packToBuffer(MEMBERS, { sourceDateEpoch: 0 });
    const reversed = await packToBuffer([...MEMBERS].reverse(), { sourceDateEpoch: 0 });
    expect(sha256(forward)).toBe(sha256(reversed));
  });

  it('changes bytes when sourceDateEpoch differs', async () => {
    const epochA = await packToBuffer(MEMBERS, { sourceDateEpoch: 1_000_000_000 });
    const epochB = await packToBuffer(MEMBERS, { sourceDateEpoch: 1_700_000_000 });
    expect(sha256(epochA)).not.toBe(sha256(epochB));
  });
});

describe('writeDeterministicZip: path safety', () => {
  async function expectRejected(members: DeterministicZipMember[]): Promise<string> {
    const destination = destinationPath();
    await expect(writeDeterministicZip(members, destination, { sourceDateEpoch: 0 })).rejects.toThrow();
    return destination;
  }

  it('rejects an absolute path', async () => {
    await expectRejected([{ path: '/etc/passwd', bytes: Buffer.from('x') }]);
  });

  it('rejects a path with a ".." segment', async () => {
    await expectRejected([{ path: '../escape.txt', bytes: Buffer.from('x') }]);
  });

  it('rejects a path with a "./" prefix', async () => {
    await expectRejected([{ path: './sneaky.txt', bytes: Buffer.from('x') }]);
  });

  it('rejects a path containing a backslash', async () => {
    await expectRejected([{ path: 'server\\index.js', bytes: Buffer.from('x') }]);
  });

  it('rejects a path with an empty segment', async () => {
    await expectRejected([{ path: 'server//index.js', bytes: Buffer.from('x') }]);
  });

  it('rejects a member ending in .node', async () => {
    await expectRejected([{ path: 'native/addon.node', bytes: Buffer.from('x') }]);
  });

  it('rejects a duplicate member name', async () => {
    await expectRejected([
      { path: 'a.txt', bytes: Buffer.from('one') },
      { path: 'a.txt', bytes: Buffer.from('two') },
    ]);
  });

  it('rejects a case-fold collision', async () => {
    await expectRejected([
      { path: 'Server/a.js', bytes: Buffer.from('one') },
      { path: 'server/a.js', bytes: Buffer.from('two') },
    ]);
  });

  it('does not write a partial artifact when rejecting a bad path', async () => {
    const destination = await expectRejected([{ path: '/etc/passwd', bytes: Buffer.from('x') }]);
    expect(existsSync(destination)).toBe(false);
  });
});

describe('writeDeterministicZip: archive limits', () => {
  it('rejects more than 10,000 members', async () => {
    const members: DeterministicZipMember[] = Array.from({ length: 10_001 }, (_, i) => ({
      path: `f${i}.txt`,
      bytes: Buffer.from('x'),
    }));
    const destination = destinationPath();
    await expect(writeDeterministicZip(members, destination, { sourceDateEpoch: 0 })).rejects.toThrow();
    expect(existsSync(destination)).toBe(false);
  });

  it('rejects a member larger than 32 MiB', async () => {
    const destination = destinationPath();
    const oversized = Buffer.alloc(32 * 1024 * 1024 + 1);
    await expect(
      writeDeterministicZip([{ path: 'big.bin', bytes: oversized }], destination, { sourceDateEpoch: 0 }),
    ).rejects.toThrow();
    expect(existsSync(destination)).toBe(false);
  }, 30_000);

  it('rejects a total payload larger than 128 MiB', async () => {
    const destination = destinationPath();
    const chunk = Buffer.alloc(27 * 1024 * 1024); // under the per-member cap
    const members: DeterministicZipMember[] = Array.from({ length: 5 }, (_, i) => ({
      path: `chunk${i}.bin`,
      bytes: chunk,
    })); // 5 * 27 MiB = 135 MiB total, over the 128 MiB cap
    await expect(writeDeterministicZip(members, destination, { sourceDateEpoch: 0 })).rejects.toThrow();
    expect(existsSync(destination)).toBe(false);
  }, 30_000);
});
