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
