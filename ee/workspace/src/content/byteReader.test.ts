import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MountedDirReader, SmbByteReader, parseMountMap, parseHostMap, parseUncRoot,
} from './byteReader';

describe('parse helpers', () => {
  it('parses a mount map env value', () => {
    expect(parseMountMap('a=/x/y,b=/z')).toEqual({ a: '/x/y', b: '/z' });
    expect(parseMountMap(undefined)).toEqual({});
  });
  it('parses a host map env value', () => {
    expect(parseHostMap('127.0.0.1=host.docker.internal')).toEqual({ '127.0.0.1': 'host.docker.internal' });
  });
  it('parses a UNC root into host and share', () => {
    expect(parseUncRoot('\\\\127.0.0.1\\alder-creek')).toEqual({ host: '127.0.0.1', share: 'alder-creek' });
    expect(() => parseUncRoot('C:\\local')).toThrow();
  });
});

describe('MountedDirReader', () => {
  let base: string;
  const source = { id: 'src-1', orgId: 'org-1', kind: 'smb_share', rootPath: '\\\\127.0.0.1\\alder-creek' };

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'wsp-content-'));
    mkdirSync(join(base, 'Projects'), { recursive: true });
    writeFileSync(join(base, 'Projects', 'doc.md'), 'hello');
    writeFileSync(join(base, 'secret-outside'), 'nope'); // sibling of the traversal target
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('reads a file under the mapped root', async () => {
    const reader = new MountedDirReader({ 'src-1': base });
    const buf = await reader.read(source, 'Projects/doc.md');
    expect(buf.toString()).toBe('hello');
  });

  it('rejects path traversal', async () => {
    const reader = new MountedDirReader({ 'src-1': join(base, 'Projects') });
    await expect(reader.read(source, '../secret-outside')).rejects.toThrow(/traversal|outside/i);
  });

  it('rejects a symlink inside the root that points outside it', async () => {
    symlinkSync(join(base, 'secret-outside'), join(base, 'Projects', 'sneaky-link'));
    const reader = new MountedDirReader({ 'src-1': join(base, 'Projects') });
    await expect(reader.read(source, 'sneaky-link')).rejects.toThrow(/symlink/i);
  });

  it('rejects a source with no mapping', async () => {
    const reader = new MountedDirReader({});
    await expect(reader.read(source, 'Projects/doc.md')).rejects.toThrow(/no mount mapping/i);
  });
});

describe('SmbByteReader', () => {
  const source = { id: 'src-1', orgId: 'org-1', kind: 'smb_share', rootPath: '\\\\127.0.0.1\\alder-creek' };

  it('connects with the decrypted credential, rewrites the host, and reads with backslashes', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const reads: string[] = [];
    const credCalls: string[] = [];
    const reader = new SmbByteReader({
      getCredential: async (orgId, sourceId) => {
        credCalls.push(`${orgId}/${sourceId}`);
        return { username: 'breeze', password: 'breezepass', domain: null };
      },
      hostMap: { '127.0.0.1': 'host.docker.internal' },
      smbFactory: (opts) => {
        calls.push(opts as unknown as Record<string, unknown>);
        return {
          readFile: async (p: string) => { reads.push(p); return Buffer.from('bytes'); },
          disconnect: () => {},
        };
      },
    });
    const buf = await reader.read(source, 'Projects/2019-112 Quail Hollow Estates ROS/deed.md');
    expect(buf.toString()).toBe('bytes');
    expect(calls[0].share).toBe('\\\\host.docker.internal\\alder-creek');
    expect(calls[0].username).toBe('breeze');
    expect(credCalls).toEqual(['org-1/src-1']);
    expect(reads[0]).toBe('Projects\\2019-112 Quail Hollow Estates ROS\\deed.md');
  });

  it('fails when no credential is stored', async () => {
    const reader = new SmbByteReader({
      getCredential: async () => null,
      hostMap: {},
      smbFactory: () => { throw new Error('must not connect'); },
    });
    await expect(reader.read(source, 'x.md')).rejects.toThrow(/credential/i);
  });

  it('reuses one client per source', async () => {
    let connects = 0;
    const reader = new SmbByteReader({
      getCredential: async () => ({ username: 'u', password: 'p', domain: null }),
      hostMap: {},
      smbFactory: () => {
        connects += 1;
        return { readFile: async () => Buffer.from('x'), disconnect: () => {} };
      },
    });
    await reader.read(source, 'a.md');
    await reader.read(source, 'b.md');
    expect(connects).toBe(1);
  });

  it('times out a read that never resolves (black-holed source) instead of hanging', async () => {
    const reader = new SmbByteReader({
      getCredential: async () => ({ username: 'u', password: 'p', domain: null }),
      hostMap: {},
      readTimeoutMs: 30,
      // readFile never settles — models a severed/partitioned SMB connection.
      smbFactory: () => ({ readFile: () => new Promise<Buffer>(() => {}), disconnect: () => {} }),
    });
    await expect(reader.read(source, 'x.md')).rejects.toThrow(/timed out/i);
  });

  it('evicts the wedged client after a failed read so the next read reconnects', async () => {
    let connects = 0;
    let disconnects = 0;
    let call = 0;
    const reader = new SmbByteReader({
      getCredential: async () => ({ username: 'u', password: 'p', domain: null }),
      hostMap: {},
      readTimeoutMs: 30,
      smbFactory: () => {
        connects += 1;
        return {
          // First client's read hangs (times out); a fresh client's read succeeds.
          readFile: () => (call++ === 0 ? new Promise<Buffer>(() => {}) : Promise.resolve(Buffer.from('ok'))),
          disconnect: () => { disconnects += 1; },
        };
      },
    });
    await expect(reader.read(source, 'a.md')).rejects.toThrow(/timed out/i);
    const buf = await reader.read(source, 'b.md');
    expect(buf.toString()).toBe('ok');
    expect(connects).toBe(2); // evicted → reconnected, not reused
    expect(disconnects).toBe(1); // wedged client was disconnected on eviction
  });
});
