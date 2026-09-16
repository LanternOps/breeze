import { describe, it, expect } from 'vitest';
import {
  buildExportStream, runWithConcurrency, ExportCapError,
  EXPORT_DEFAULT_MAX_ROWS, EXPORT_HARD_MAX_ROWS, EXPORT_WALL_MS,
  type ExportPage,
} from './aiToolsExportWriter';

async function drain(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

function pagerOf(pages: ExportPage[]) {
  const calls: Array<string | null> = [];
  return {
    calls,
    pager: async (cursor: string | null) => {
      calls.push(cursor);
      return pages[calls.length - 1] ?? { rows: [], nextCursor: null };
    },
  };
}

describe('buildExportStream', () => {
  it('pages a three-page source to completion as JSONL, one object per line', async () => {
    const { pager, calls } = pagerOf([
      { rows: [{ id: 1 }, { id: 2 }], nextCursor: 'c1' },
      { rows: [{ id: 3 }], nextCursor: 'c2' },
      { rows: [{ id: 4 }], nextCursor: null },
    ]);
    const out = buildExportStream(pager, { format: 'jsonl', maxRows: 100, maxBytes: 1e6, wallMs: 60_000 });
    const text = await drain(out.body);
    const stats = await out.stats;

    expect(calls).toEqual([null, 'c1', 'c2']);
    const lines = text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => JSON.parse(l).id)).toEqual([1, 2, 3, 4]);
    expect(stats.rows).toBe(4);
    expect(stats.truncated).toBe(false);
    expect(stats.bytes).toBe(Buffer.byteLength(text));
  });

  it('stops early at the row cap and reports truncated: true', async () => {
    const { pager } = pagerOf([
      { rows: [{ id: 1 }, { id: 2 }], nextCursor: 'c1' },
      { rows: [{ id: 3 }, { id: 4 }], nextCursor: 'c2' },
      { rows: [{ id: 5 }], nextCursor: null },
    ]);
    const out = buildExportStream(pager, { format: 'jsonl', maxRows: 3, maxBytes: 1e6, wallMs: 60_000 });
    const text = await drain(out.body);
    const stats = await out.stats;
    expect(text.split('\n').filter(Boolean)).toHaveLength(3);
    expect(stats.rows).toBe(3);
    expect(stats.truncated).toBe(true);
  });

  it('stops at the wall clock and reports truncated: true', async () => {
    let clock = 0;
    const pager = async (): Promise<ExportPage> => { clock += 40_000; return { rows: [{ id: clock }], nextCursor: 'more' }; };
    const out = buildExportStream(pager, { format: 'jsonl', maxRows: 1e6, maxBytes: 1e6, wallMs: 60_000, now: () => clock });
    await drain(out.body);
    const stats = await out.stats;
    expect(stats.truncated).toBe(true);
    expect(stats.rows).toBeLessThan(10);
  });

  it('aborts with a typed ExportCapError when the byte cap is crossed', async () => {
    const big = 'x'.repeat(4096);
    const pager = async (): Promise<ExportPage> => ({ rows: [{ blob: big }], nextCursor: 'more' });
    const out = buildExportStream(pager, { format: 'jsonl', maxRows: 1e6, maxBytes: 8192, wallMs: 60_000 });
    await expect(drain(out.body)).rejects.toBeInstanceOf(ExportCapError);
    await expect(out.stats).rejects.toMatchObject({ code: 'artifact_bytes_exceeded' });
  });

  it('writes a CSV header from the first row and escapes quotes and newlines', async () => {
    const { pager } = pagerOf([
      { rows: [{ name: 'say "hi"', note: 'line1\nline2' }, { name: 'plain', note: 'ok' }], nextCursor: null },
    ]);
    const out = buildExportStream(pager, { format: 'csv', maxRows: 100, maxBytes: 1e6, wallMs: 60_000 });
    const text = await drain(out.body);
    const lines = text.split('\n');
    expect(lines[0]).toBe('"name","note"');
    expect(lines[1]).toBe('"say ""hi""","line1');
    expect(lines[2]).toBe('line2"');
    expect(text).toContain('"plain","ok"');
  });

  it('JSON-encodes non-scalar CSV cells instead of stringifying them as [object Object]', async () => {
    const { pager } = pagerOf([
      { rows: [{ deviceId: 'd1', fields: { code: 1, note: 'x' } }], nextCursor: null },
    ]);
    const out = buildExportStream(pager, { format: 'csv', maxRows: 100, maxBytes: 1e6, wallMs: 60_000 });
    const text = await drain(out.body);
    expect(text).not.toContain('[object Object]');
    expect(text).toContain('"{""code"":1,""note"":""x""}"');
  });

  it('emits head and tail previews of the RAW bytes, capped', async () => {
    const { pager } = pagerOf([{ rows: Array.from({ length: 500 }, (_, i) => ({ i })), nextCursor: null }]);
    const out = buildExportStream(pager, { format: 'jsonl', maxRows: 1000, maxBytes: 1e6, wallMs: 60_000 });
    const text = await drain(out.body);
    const stats = await out.stats;
    expect(text.startsWith(stats.head)).toBe(true);
    expect(text.endsWith(stats.tail)).toBe(true);
    expect(Buffer.byteLength(stats.head)).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(stats.tail)).toBeLessThanOrEqual(2048);
  });

  it('exposes the spec caps', () => {
    expect(EXPORT_DEFAULT_MAX_ROWS).toBe(200_000);
    expect(EXPORT_HARD_MAX_ROWS).toBe(1_000_000);
    expect(EXPORT_WALL_MS).toBe(120_000);
  });
});

describe('runWithConcurrency', () => {
  it('never exceeds the requested concurrency', async () => {
    let active = 0;
    let peak = 0;
    await runWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });
});
