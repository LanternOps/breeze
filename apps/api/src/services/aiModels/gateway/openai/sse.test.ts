import { describe, expect, it } from 'vitest';
import { encodeSse, parseSse } from './sse';
async function* bytes(...parts: string[]) { for (const p of parts) yield new TextEncoder().encode(p); }
async function collect(src: AsyncIterable<{ event: string | null; data: string }>) { const out = []; for await (const e of src) out.push(e); return out; }
describe('sse', () => {
  it('reassembles events split across chunks and CRLF', async () => { expect(await collect(parseSse(bytes('data: {"a"', ':1}\r\n\r\nevent: x\ndata: 2\n\n')))).toEqual([{ event: null, data: '{"a":1}' }, { event: 'x', data: '2' }]); });
  it('ignores comments and caps a single event', async () => { expect(await collect(parseSse(bytes(': keepalive\n\n')))).toEqual([]); await expect(collect(parseSse(bytes(`data: ${'a'.repeat(100)}\n\n`), 50))).rejects.toThrow(/too large/); });
  it('encodes', () => { expect(new TextDecoder().decode(encodeSse('ping', { type: 'ping' }))).toBe('event: ping\ndata: {"type":"ping"}\n\n'); });
});
