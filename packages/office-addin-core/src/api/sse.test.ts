import { describe, expect, it } from 'vitest';
import { parseSseStream, type SseFrame } from './sse';

const encoder = new TextEncoder();

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of parseSseStream(streamFrom(chunks))) frames.push(frame);
  return frames;
}

describe('parseSseStream', () => {
  it('parses a single event frame', async () => {
    const frames = await collect(['event: message_delta\ndata: {"text":"hi"}\n\n']);
    expect(frames).toEqual([{ event: 'message_delta', data: '{"text":"hi"}' }]);
  });

  it('handles events split across arbitrary chunk boundaries', async () => {
    const frames = await collect([
      'event: mess',
      'age_delta\nda',
      'ta: {"text":"x',
      'y"}\n',
      '\nevent: ping\ndata: {}\n\n',
    ]);
    expect(frames).toEqual([
      { event: 'message_delta', data: '{"text":"xy"}' },
      { event: 'ping', data: '{}' },
    ]);
  });

  it('joins multi-line data with newlines', async () => {
    const frames = await collect(['event: message_delta\ndata: line1\ndata: line2\n\n']);
    expect(frames).toEqual([{ event: 'message_delta', data: 'line1\nline2' }]);
  });

  it('accepts CRLF line endings', async () => {
    const frames = await collect(['event: ping\r\ndata: {}\r\n\r\n']);
    expect(frames).toEqual([{ event: 'ping', data: '{}' }]);
  });

  it('ignores comments and unknown fields', async () => {
    const frames = await collect([
      ': keepalive comment\nid: 42\nretry: 5000\nevent: ping\ndata: {}\n\n',
    ]);
    expect(frames).toEqual([{ event: 'ping', data: '{}' }]);
  });

  it("defaults the event name to 'message' when no event line is present", async () => {
    const frames = await collect(['data: {"a":1}\n\n']);
    expect(frames).toEqual([{ event: 'message', data: '{"a":1}' }]);
  });

  it('flushes a final frame when the stream ends without a trailing blank line', async () => {
    const frames = await collect(['event: session_error\ndata: {"message":"boom"}']);
    expect(frames).toEqual([{ event: 'session_error', data: '{"message":"boom"}' }]);
  });
});
