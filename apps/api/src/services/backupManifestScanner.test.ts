import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  MANIFEST_ENTRY_MAX_CHARS,
  ManifestScanError,
  createManifestScanner,
  scanManifest,
} from './backupManifestScanner';

const scan = async (json: string | Buffer, chunkSize = 7) => {
  const bytes = Buffer.isBuffer(json) ? json : Buffer.from(json);
  const chunks: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(bytes.subarray(i, i + chunkSize));
  const entries: unknown[] = [];
  const result = await scanManifest(Readable.from(chunks), {
    onEntry: (entry) => {
      entries.push(entry);
    },
  });
  return { ...result, seen: entries };
};

describe('scanManifest', () => {
  it('hands over the first entry before the source has finished, so entries are never collected', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* source() {
      yield Buffer.from('{"id":"s1","files":[{"sourcePath":"/a","backupPath":"k"},');
      // Only onEntry for the first entry releases this; a scanner that waited
      // for the whole document would hang here until the test times out.
      await gate;
      yield Buffer.from('{"sourcePath":"/b","backupPath":"k2"}]}');
    }
    const seen: string[] = [];
    const result = await scanManifest(Readable.from(source()), {
      onEntry: (entry) => {
        seen.push((entry as { sourcePath: string }).sourcePath);
        release();
      },
    });
    expect(seen).toEqual(['/a', '/b']);
    expect(result).toEqual({ id: 's1', entries: 2, hasFilesKey: true });
  });

  it('does not care about key order', async () => {
    const result = await scan('{"files":[{"sourcePath":"/a"}],"timestamp":"t","id":"s1"}');
    expect(result).toMatchObject({ id: 's1', entries: 1, hasFilesKey: true });
  });

  it('skips securityDescriptors and every other top-level key, including nested and look-alike ones', async () => {
    const result = await scan(JSON.stringify({
      securityDescriptors: ['O:BA', 'O:SY'],
      nested: { files: [{ sourcePath: '/not-an-entry' }], id: 'not-the-id', deep: [[[{ files: [] }]]] },
      size: 12,
      flag: true,
      nothing: null,
      id: 's1',
      files: [{ sourcePath: '/real' }],
    }));
    expect(result.id).toBe('s1');
    expect(result.seen).toEqual([{ sourcePath: '/real' }]);
  });

  it('awaits an async handler, in order, one entry at a time', async () => {
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    await scanManifest(
      Readable.from([Buffer.from(JSON.stringify({ id: 's', files: [{ a: 1 }, { a: 2 }, { a: 3 }] }))]),
      {
        onEntry: async (entry, index) => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 2));
          order.push((entry as { a: number }).a * 10 + index);
          running -= 1;
        },
      },
    );
    expect(peak).toBe(1);
    expect(order).toEqual([10, 21, 32]);
  });

  it('builds each entry exactly as JSON.parse would', async () => {
    const entry = {
      sourcePath: 'C:\\Users\\zoë\\日本語\\😀.txt',
      backupPath: 'snapshots/s/files/x',
      size: 1.5e3,
      negative: -2,
      flagged: true,
      off: false,
      nothing: null,
      nested: { list: [1, 'two', [3], { four: 4 }], empty: {}, none: [] },
    };
    // A chunk size of 1 splits every multi-byte character across chunks.
    const { seen } = await scan(JSON.stringify({ id: 's', files: [entry] }), 1);
    expect(seen).toEqual([entry]);
  });

  it('keeps a __proto__ key as a plain own property, never the prototype', async () => {
    const { seen } = await scan('{"id":"s","files":[{"__proto__":{"polluted":true},"sourcePath":"/a"}]}');
    const entry = seen[0] as Record<string, unknown>;
    expect(Object.getPrototypeOf(entry)).toBe(Object.prototype);
    expect((entry as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.keys(entry)).toContain('__proto__');
  });

  it('passes non-object entries through for the caller to judge', async () => {
    const { seen, entries } = await scan('{"id":"s","files":[1,"two",null,[3]]}');
    expect(entries).toBe(4);
    expect(seen).toEqual([1, 'two', null, [3]]);
  });

  it.each([
    ['malformed JSON', '{"id":"s",,}'],
    ['truncated input', '{"id":"s","files":[{"sourcePath":"/a"}'],
    ['empty input', ''],
    ['trailing data', '{"id":"s"} {"id":"t"}'],
    ['files as an object', '{"id":"s","files":{}}'],
    ['files as a string', '{"id":"s","files":"x"}'],
    ['files as a number', '{"id":"s","files":1}'],
    ['files as a boolean', '{"id":"s","files":true}'],
    ['a root array', '[{"id":"s"}]'],
    ['a root scalar', '"s"'],
    ['two files arrays, which JSON.parse would silently resolve to the last', '{"id":"s","files":[{"a":1}],"files":[{"a":2}]}'],
    ['two ids', '{"id":"s","id":"t","files":[]}'],
  ])('throws ManifestScanError on %s', async (_name, json) => {
    const failure = await scan(json).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ManifestScanError);
    expect((failure as ManifestScanError).kind).toBe('malformed');
  });

  it('reports no files key as zero entries', async () => {
    expect(await scan('{"id":"s"}')).toMatchObject({ id: 's', entries: 0, hasFilesKey: false });
  });

  it('reads a null files key, which is what the agent writes for a nil slice, as zero entries', async () => {
    expect(await scan('{"id":"s","files":null}')).toMatchObject({ id: 's', entries: 0, hasFilesKey: true });
  });

  it('reports a missing or non-string id as null', async () => {
    expect(await scan('{"files":[]}')).toMatchObject({ id: null });
    expect(await scan('{"id":7,"files":[]}')).toMatchObject({ id: null });
    expect(await scan('{"id":{"nested":"x"},"files":[]}')).toMatchObject({ id: null });
  });

  it('refuses an entry over the size limit as a limit, not as malformed', async () => {
    const huge = 'x'.repeat(MANIFEST_ENTRY_MAX_CHARS + 1);
    const failure = await scan(`{"id":"s","files":[{"sourcePath":"${huge}"}]}`, 65536).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ManifestScanError);
    expect((failure as ManifestScanError).kind).toBe('limit');
  });

  it('refuses an entry nested too deeply as a limit', async () => {
    const depth = 200;
    const failure = await scan(`{"id":"s","files":[${'['.repeat(depth)}${']'.repeat(depth)}]}`).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ManifestScanError);
    expect((failure as ManifestScanError).kind).toBe('limit');
  });

  it('refuses an oversized id as a limit', async () => {
    const failure = await scan(`{"id":"${'x'.repeat(5000)}","files":[]}`).catch((err: unknown) => err);
    expect((failure as ManifestScanError).kind).toBe('limit');
  });

  it('never accumulates a skipped value: a value larger than the entry limit passes through', async () => {
    const huge = 'x'.repeat(MANIFEST_ENTRY_MAX_CHARS * 3);
    const result = await scan(`{"unknownBlob":"${huge}","unknownKey${huge}":1,"id":"s","files":[]}`, 65536);
    expect(result).toMatchObject({ id: 's', entries: 0, hasFilesKey: true });
  });

  it('propagates a source error rather than reading it as the end of the document', async () => {
    async function* source() {
      yield Buffer.from('{"id":"s","files":[{"a":1},');
      throw new Error('connection reset');
    }
    await expect(scanManifest(Readable.from(source()), { onEntry: vi.fn() })).rejects.toThrow('connection reset');
  });

  it('propagates a handler error untouched and stops reading', async () => {
    const handlerError = new Error('stop here');
    const onEntry = vi.fn().mockImplementation(() => {
      throw handlerError;
    });
    await expect(
      scanManifest(Readable.from([Buffer.from('{"id":"s","files":[{"a":1},{"a":2}]}')]), { onEntry }),
    ).rejects.toBe(handlerError);
    expect(onEntry).toHaveBeenCalledTimes(1);
  });
});

describe('createManifestScanner', () => {
  it('can be fed by a caller that also needs the bytes, with a synchronous handler', async () => {
    const seen: unknown[] = [];
    const scanner = createManifestScanner({
      onEntry: (entry) => {
        seen.push(entry);
      },
    });
    await scanner.write(Buffer.from('{"id":"s","fil'));
    await scanner.write(Buffer.from('es":[{"a":1}]}'));
    expect(scanner.finish()).toEqual({ id: 's', entries: 1, hasFilesKey: true });
    expect(seen).toEqual([{ a: 1 }]);
  });
});

describe('scanManifest top-level fields (#11233)', () => {
  const scanFields = async (json: string, fields: readonly string[], chunkSize = 5) => {
    const bytes = Buffer.from(json);
    const chunks: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(bytes.subarray(i, i + chunkSize));
    return scanManifest(Readable.from(chunks), { onEntry: () => {} }, { fields });
  };

  it('keeps the scalar value of each requested top-level key, as JSON.parse reads it', async () => {
    const result = await scanFields(
      '{"timestamp":"2026-11-01T00:00:00Z","size":1234.5,"formatVersion":2,"files":[{"a":1}],"baseSnapshotId":"s0","id":"s1","sealed":true,"note":null}',
      ['timestamp', 'size', 'formatVersion', 'baseSnapshotId', 'sealed', 'note'],
    );
    expect(result).toEqual({
      id: 's1',
      entries: 1,
      hasFilesKey: true,
      fields: { timestamp: '2026-11-01T00:00:00Z', size: 1234.5, formatVersion: 2, baseSnapshotId: 's0', sealed: true, note: null },
    });
  });

  it('leaves out a requested key the manifest does not have, and keeps nothing it was not asked for', async () => {
    const result = await scanFields('{"id":"s1","size":10,"files":[]}', ['timestamp']);
    expect(result.fields).toEqual({});
  });

  it('reports no fields when none were requested, so existing callers see the same result', async () => {
    expect(await scanFields('{"id":"s1","size":10,"files":[]}', [])).toEqual({ id: 's1', entries: 0, hasFilesKey: true, fields: {} });
    const plain = await scanManifest(Readable.from([Buffer.from('{"id":"s1","size":10,"files":[]}')]), { onEntry: () => {} });
    expect(plain).toEqual({ id: 's1', entries: 0, hasFilesKey: true });
  });

  it('refuses a requested key whose value is an object or an array as malformed', async () => {
    for (const json of ['{"id":"s","size":{"n":1},"files":[]}', '{"id":"s","size":[1],"files":[]}']) {
      const failure = await scanFields(json, ['size']).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(ManifestScanError);
      expect((failure as ManifestScanError).kind).toBe('malformed');
    }
  });

  it('refuses a requested key that appears twice as malformed', async () => {
    const failure = await scanFields('{"id":"s","size":1,"size":2,"files":[]}', ['size']).catch((err: unknown) => err);
    expect((failure as ManifestScanError).kind).toBe('malformed');
  });

  it('refuses an oversized requested value as a limit', async () => {
    const failure = await scanFields(`{"id":"s","timestamp":"${'x'.repeat(5000)}","files":[]}`, ['timestamp'], 65536).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ManifestScanError);
    expect((failure as ManifestScanError).kind).toBe('limit');
  });

  it('refuses a request for a key it cannot match or already owns', () => {
    expect(() => createManifestScanner({ onEntry: () => {} }, { fields: ['aKeyLongerThanSixteen'] })).toThrow();
    expect(() => createManifestScanner({ onEntry: () => {} }, { fields: ['files'] })).toThrow();
    expect(() => createManifestScanner({ onEntry: () => {} }, { fields: ['id'] })).toThrow();
  });
});
