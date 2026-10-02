const enc = new TextEncoder();

/** Minimal SSE reader (data/event fields only). Throws when one event exceeds maxEventBytes. */
export async function* parseSse(
  source: AsyncIterable<Uint8Array>,
  maxEventBytes = 4 * 1024 * 1024,
): AsyncIterable<{ event: string | null; data: string }> {
  // Keep a decoder per stream so split multi-byte sequences cannot leak between responses.
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of source) {
    buf = (buf + dec.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    if (buf.length > maxEventBytes && !buf.includes('\n\n')) throw new Error('SSE event too large');
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (raw.length > maxEventBytes) throw new Error('SSE event too large');
      let event: string | null = null;
      const data: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length > 0) yield { event, data: data.join('\n') };
    }
  }
  buf += dec.decode();
  const tail = buf.replace(/\r\n/g, '\n').trim();
  if (tail.startsWith('data:')) yield { event: null, data: tail.slice(5).replace(/^ /, '') };
}

export function encodeSse(event: string, data: unknown): Uint8Array {
  return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
