/**
 * SSE parser over a fetch ReadableStream. EventSource cannot set the
 * Authorization header, so the add-in consumes GET /events with fetch and
 * parses frames manually (the server's GET-only ?token= fallback exists for
 * EventSource clients; this client never uses it).
 *
 * Implements the SSE wire format subset the server emits: `event:` + one or
 * more `data:` lines per frame, blank-line dispatch, `:` comments and
 * `id:`/`retry:` fields ignored, CRLF tolerated, frames may be split across
 * arbitrary chunk boundaries.
 */

export type SseFrame = { event: string; data: string };

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];

  const flush = (): SseFrame | null => {
    if (dataLines.length === 0) {
      eventName = '';
      return null;
    }
    const frame = { event: eventName || 'message', data: dataLines.join('\n') };
    eventName = '';
    dataLines = [];
    return frame;
  };

  const handleLine = (rawLine: string): SseFrame | null => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') return flush();
    if (line.startsWith(':')) return null; // comment / keepalive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    // id: / retry: / anything else — ignored
    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const frame = handleLine(line);
        if (frame) yield frame;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const frame = handleLine(buffer);
      if (frame) yield frame;
    }
    const last = flush();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
