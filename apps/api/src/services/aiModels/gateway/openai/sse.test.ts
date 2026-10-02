import { describe, expect, it } from 'vitest';
import { encodeSse, parseSse } from './sse';
async function* bytes(...parts: string[]) { for (const p of parts) yield new TextEncoder().encode(p); }
async function collect(src: AsyncIterable<{ event: string | null; data: string }>) { const out = []; for await (const e of src) out.push(e); return out; }
describe('sse', () => {
  it('reassembles events split across chunks and CRLF', async () => { expect(await collect(parseSse(bytes('data: {"a"', ':1}\r\n\r\nevent: x\ndata: 2\n\n')))).toEqual([{ event: null, data: '{"a":1}' }, { event: 'x', data: '2' }]); });
  it('ignores comments and caps a single event', async () => { expect(await collect(parseSse(bytes(': keepalive\n\n')))).toEqual([]); await expect(collect(parseSse(bytes(`data: ${'a'.repeat(100)}\n\n`), 50))).rejects.toThrow(/too large/); });
  it('encodes', () => { expect(new TextDecoder().decode(encodeSse('ping', { type: 'ping' }))).toBe('event: ping\ndata: {"type":"ping"}\n\n'); });
});

// A payload with no event separator, delivered in many small chunks.
function noSeparatorChunks(totalBytes: number, chunkBytes: number): AsyncIterable<Uint8Array> {
  const all = new TextEncoder().encode(`data: ${'a'.repeat(totalBytes)}`);
  return (async function* gen() { for (let i = 0; i < all.length; i += chunkBytes) yield all.subarray(i, i + chunkBytes); })();
}

describe('sse bounded work', () => {
  it('rejects a 1 MiB event with no separator, streamed in 100-byte chunks, in linear time', async () => {
    const src = noSeparatorChunks(1024 * 1024, 100);
    const t0 = performance.now();
    await expect(collect(parseSse(src))).rejects.toThrow(/too large/);
    expect(performance.now() - t0).toBeLessThan(500);
  });
  it('counts the cap in UTF-8 bytes, not UTF-16 units', async () => {
    // 40 three-byte characters = 120 bytes but only 40 UTF-16 units.
    await expect(collect(parseSse(bytes(`data: ${'€'.repeat(40)}\n\n`), 100))).rejects.toThrow(/too large/);
    await expect(collect(parseSse(bytes(`data: ${'€'.repeat(40)}`, '\n\n'), 100))).rejects.toThrow(/too large/);
  });
  it('handles a CRLF separator split across chunks and a lone CR line ending', async () => {
    expect(await collect(parseSse(bytes('data: 1\r', '\n\r', '\ndata: 2\r\n', '\r\n', 'data: 3\r\rdata: 4')))).toEqual([
      { event: null, data: '1' }, { event: null, data: '2' }, { event: null, data: '3' }, { event: null, data: '4' },
    ]);
  });
  it('finds a separator that straddles two chunks', async () => {
    expect(await collect(parseSse(bytes('data: a\n', '\ndata: b\n', '\n')))).toEqual([{ event: null, data: 'a' }, { event: null, data: 'b' }]);
  });
  it('yields many events delivered in one chunk', async () => {
    const big = Array.from({ length: 5000 }, (_, i) => `data: ${i}\n\n`).join('');
    const out = await collect(parseSse(bytes(big)));
    expect(out).toHaveLength(5000); expect(out.at(-1)).toEqual({ event: null, data: '4999' });
  });
  it('a multi-byte character split across chunks decodes intact', async () => {
    const b = new TextEncoder().encode('data: €\n\n');
    async function* split() { yield b.subarray(0, 7); yield b.subarray(7); }
    expect(await collect(parseSse(split()))).toEqual([{ event: null, data: '€' }]);
  });
  it('a final event without a trailing blank line is still parsed', async () => {
    expect(await collect(parseSse(bytes('event: x\ndata: a\ndata: b')))).toEqual([{ event: 'x', data: 'a\nb' }]);
  });
});

describe('sse event cap is independent of chunking', () => {
  type Outcome = { ok: Array<{ event: string | null; data: string }> } | { err: string };
  async function outcome(chunks: string[], cap: number): Promise<Outcome> {
    try { return { ok: await collect(parseSse(bytes(...chunks), cap)) }; } catch (e) { return { err: (e as Error).message }; }
  }
  /** The whole stream, every two-way split, and one character per chunk. */
  function chunkings(s: string): string[][] {
    const out: string[][] = [[s], s.split('')];
    for (let i = 1; i < s.length; i++) out.push([s.slice(0, i), s.slice(i)]);
    return out;
  }

  const cases: Array<{ name: string; stream: string; cap: number; expect: 'ok' | 'too large' }> = [
    // The event body is the text between separators: 'data: xx' is 8 bytes.
    { name: 'LF event exactly at the cap', stream: 'data: xx\n\n', cap: 8, expect: 'ok' },
    { name: 'LF event one byte over', stream: 'data: xx\n\n', cap: 7, expect: 'too large' },
    { name: 'CRLF event exactly at the cap', stream: 'data: xx\r\n\r\n', cap: 8, expect: 'ok' },
    { name: 'CR-only event exactly at the cap', stream: 'data: xx\r\r', cap: 8, expect: 'ok' },
    { name: 'two-line event at the cap (inner newline counts)', stream: 'data: x\ndata: y\n\n', cap: 15, expect: 'ok' },
    { name: 'two-line event one byte over', stream: 'data: x\ndata: y\n\n', cap: 14, expect: 'too large' },
    { name: 'two events, each at the cap', stream: 'data: aa\n\ndata: bb\n\n', cap: 8, expect: 'ok' },
  ];

  for (const c of cases) {
    it(`${c.name}: every chunking agrees (${c.expect})`, async () => {
      for (const chunks of chunkings(c.stream)) {
        const got = await outcome(chunks, c.cap);
        if (c.expect === 'ok') {
          expect({ chunks, ok: 'ok' in got && got.ok.length > 0 }).toEqual({ chunks, ok: true });
        } else {
          expect({ chunks, got }).toEqual({ chunks, got: { err: 'SSE event too large' } });
        }
      }
    });
  }
});
