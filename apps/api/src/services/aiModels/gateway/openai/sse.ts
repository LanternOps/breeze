import { GATEWAY_MAX_SSE_EVENT_BYTES } from '../limits';

const enc = new TextEncoder();

export interface SseEvent { event: string | null; data: string }

function parseEvent(raw: string): SseEvent | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length > 0 ? { event, data: data.join('\n') } : null;
}

/**
 * Minimal SSE reader (data/event fields only). Throws when one event exceeds
 * maxEventBytes (UTF-8 bytes).
 *
 * The upstream is untrusted, so the work per chunk is proportional to that
 * chunk, never to what is already buffered: line endings are normalised on the
 * new text only (a trailing CR is held back until the next chunk shows whether
 * it starts a CRLF), the separator is searched for in the new text only (plus
 * the one-character seam with the previous piece), and the pending event is
 * kept as a list of pieces with a running byte count. The cap applies to the
 * event text between separators, so where a chunk boundary falls never changes
 * whether an event fits.
 */
export async function* parseSse(
  source: AsyncIterable<Uint8Array>,
  maxEventBytes = GATEWAY_MAX_SSE_EVENT_BYTES,
): AsyncIterable<SseEvent> {
  // Keep a decoder per stream so split multi-byte sequences cannot leak between responses.
  const dec = new TextDecoder();
  let parts: string[] = [];
  let partBytes = 0;
  let endsWithLf = false;
  let carryCr = false;
  const tooLarge = (): Error => new Error('SSE event too large');

  function* feed(text: string, final: boolean): Generator<SseEvent> {
    let t = carryCr ? `\r${text}` : text;
    carryCr = !final && t.endsWith('\r');
    if (carryCr) t = t.slice(0, -1);
    t = t.replace(/\r\n?/g, '\n');
    if (t.length === 0) return;
    let pos = 0;
    if (endsWithLf && t[0] === '\n') {
      // The blank line straddles the previous piece and this one.
      const raw = parts.join('').slice(0, -1);
      parts = []; partBytes = 0; endsWithLf = false; pos = 1;
      const ev = parseEvent(raw);
      if (ev) yield ev;
    }
    let i: number;
    while ((i = t.indexOf('\n\n', pos)) >= 0) {
      const piece = t.slice(pos, i);
      if (partBytes + Buffer.byteLength(piece, 'utf8') > maxEventBytes) throw tooLarge();
      const raw = parts.length > 0 ? parts.join('') + piece : piece;
      parts = []; partBytes = 0; endsWithLf = false; pos = i + 2;
      const ev = parseEvent(raw);
      if (ev) yield ev;
    }
    if (pos < t.length) {
      const rest = t.slice(pos);
      parts.push(rest);
      partBytes += Buffer.byteLength(rest, 'utf8');
      endsWithLf = rest.endsWith('\n');
      // A trailing LF may be the first half of the separator, which is not part
      // of the event; count it only once the next text shows it is content (it
      // then rides in partBytes into the piece check above). This keeps the cap
      // decision identical however the stream is chunked.
      if (partBytes - (endsWithLf ? 1 : 0) > maxEventBytes) throw tooLarge();
    }
  }

  for await (const chunk of source) yield* feed(dec.decode(chunk, { stream: true }), false);
  yield* feed(dec.decode(), true);
  if (parts.length > 0) {
    const ev = parseEvent(parts.join(''));
    if (ev) yield ev;
  }
}

export function encodeSse(event: string, data: unknown): Uint8Array {
  return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
