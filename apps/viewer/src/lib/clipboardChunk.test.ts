import { describe, it, expect } from 'vitest';
import {
  CHUNK_PIECE_BYTES,
  CHUNK_FRAME_MAX_BYTES,
  MAX_ASSEMBLED_BYTES,
  CHUNK_TRANSFER_TIMEOUT_MS,
  MAX_TRANSFER_ID_BYTES,
  ChunkAssembler,
  encodeChunks,
  newTransferId,
  bytesToBase64,
  base64ToBytes,
  type ChunkFrame,
} from './clipboardChunk';

// Ported from agent/internal/remote/clipboard/chunk_test.go (W4a, #8240): the
// two ends must agree on every limit, or one side rejects what the other sends.

function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

// toEqual on a multi-MiB typed array is a deep walk that takes seconds.
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function roundTrip(inner: Uint8Array): Uint8Array {
  const frames = encodeChunks('t1', inner);
  const a = new ChunkAssembler();
  let out: Uint8Array | null = null;
  frames.forEach((raw, i) => {
    expect(raw.length, `frame ${i}`).toBeLessThanOrEqual(CHUNK_FRAME_MAX_BYTES);
    const res = a.add(JSON.parse(raw) as ChunkFrame);
    if (i < frames.length - 1) expect(res).toBeNull();
    else out = res;
  });
  expect(out).not.toBeNull();
  return out!;
}

describe('clipboard chunk constants', () => {
  it('match the agent exactly', () => {
    expect(CHUNK_PIECE_BYTES).toBe(32 * 1024);
    expect(CHUNK_FRAME_MAX_BYTES).toBe(48 * 1024);
    expect(MAX_ASSEMBLED_BYTES).toBe(12 * 1024 * 1024);
    expect(CHUNK_TRANSFER_TIMEOUT_MS).toBe(30_000);
    expect(MAX_TRANSFER_ID_BYTES).toBe(64);
  });
});

describe('encodeChunks / ChunkAssembler', () => {
  it.each([0, 1, CHUNK_PIECE_BYTES, CHUNK_PIECE_BYTES + 1, 9 * 1024 * 1024])('round-trips %i bytes', (n) => {
    const inner = bytes(n);
    expect(sameBytes(roundTrip(inner), inner)).toBe(true);
  });

  it('emits frames with exactly the agent struct keys', () => {
    const [raw] = encodeChunks('abc', bytes(10));
    const f = JSON.parse(raw);
    expect(Object.keys(f).sort()).toEqual(['data', 'id', 'seq', 'total', 'type']);
    expect(f).toMatchObject({ type: 'chunk', id: 'abc', seq: 0, total: 1 });
  });

  it('uses one frame for an empty message', () => {
    expect(encodeChunks('e', new Uint8Array(0))).toHaveLength(1);
  });

  it('refuses to encode more than the assembled cap', () => {
    expect(() => encodeChunks('big', new Uint8Array(MAX_ASSEMBLED_BYTES + 1))).toThrow();
  });

  it('lets a new transfer replace a partial one', () => {
    const a = new ChunkAssembler();
    const first = encodeChunks('one', bytes(CHUNK_PIECE_BYTES * 2));
    expect(a.add(JSON.parse(first[0]))).toBeNull();
    const second = encodeChunks('two', bytes(5, 99));
    expect(a.add(JSON.parse(second[0]))).toEqual(bytes(5, 99));
  });

  it('rejects a frame for an unknown transfer', () => {
    const a = new ChunkAssembler();
    const frames = encodeChunks('one', bytes(CHUNK_PIECE_BYTES * 2));
    expect(() => a.add({ ...JSON.parse(frames[1]), id: 'other' })).toThrow(/unknown transfer/);
  });

  it('rejects a frame out of sequence', () => {
    const a = new ChunkAssembler();
    const frames = encodeChunks('one', bytes(CHUNK_PIECE_BYTES * 3));
    a.add(JSON.parse(frames[0]));
    expect(() => a.add(JSON.parse(frames[2]))).toThrow(/out of sequence/);
  });

  it('rejects a duplicate frame', () => {
    const a = new ChunkAssembler();
    const frames = encodeChunks('one', bytes(CHUNK_PIECE_BYTES * 3));
    a.add(JSON.parse(frames[0]));
    a.add(JSON.parse(frames[1]));
    expect(() => a.add(JSON.parse(frames[1]))).toThrow(/out of sequence/);
  });

  it('rejects an oversized total', () => {
    const a = new ChunkAssembler();
    const total = Math.floor(MAX_ASSEMBLED_BYTES / CHUNK_PIECE_BYTES) + 2;
    expect(() => a.add({ type: 'chunk', id: 'x', seq: 0, total, data: '' })).toThrow(/header/);
  });

  it('rejects an oversized piece', () => {
    const a = new ChunkAssembler();
    const data = bytesToBase64(bytes(CHUNK_PIECE_BYTES + 1));
    expect(() => a.add({ type: 'chunk', id: 'x', seq: 0, total: 2, data })).toThrow(/size limits/);
  });

  it('rejects a transfer id over 64 bytes', () => {
    const a = new ChunkAssembler();
    expect(() => a.add({ type: 'chunk', id: 'i'.repeat(65), seq: 0, total: 1, data: '' })).toThrow(/header/);
  });

  it('rejects a missing id and a seq outside the total', () => {
    const a = new ChunkAssembler();
    expect(() => a.add({ type: 'chunk', id: '', seq: 0, total: 1, data: '' })).toThrow();
    expect(() => a.add({ type: 'chunk', id: 'x', seq: 1, total: 1, data: '' })).toThrow();
    expect(() => a.add({ type: 'chunk', id: 'x', seq: -1, total: 1, data: '' })).toThrow();
  });

  it('rejects non-base64 data', () => {
    const a = new ChunkAssembler();
    expect(() => a.add({ type: 'chunk', id: 'x', seq: 0, total: 1, data: '***' })).toThrow(/data/);
  });

  it('drops a transfer after 30 s without a frame', () => {
    let now = 0;
    const a = new ChunkAssembler(() => now);
    const frames = encodeChunks('slow', bytes(CHUNK_PIECE_BYTES * 2));
    a.add(JSON.parse(frames[0]));
    now += CHUNK_TRANSFER_TIMEOUT_MS + 1;
    expect(() => a.add(JSON.parse(frames[1]))).toThrow(/timed out/);
  });

  it('allows a slow but steady transfer (inactivity, not total, limit)', () => {
    let now = 0;
    const a = new ChunkAssembler(() => now);
    const inner = bytes(CHUNK_PIECE_BYTES * 4);
    const frames = encodeChunks('steady', inner);
    let out: Uint8Array | null = null;
    for (const f of frames) {
      now += CHUNK_TRANSFER_TIMEOUT_MS - 1;
      out = a.add(JSON.parse(f));
    }
    expect(out).toEqual(inner);
  });

  it('resets after an error so the next transfer starts clean', () => {
    const a = new ChunkAssembler();
    const frames = encodeChunks('one', bytes(CHUNK_PIECE_BYTES * 2));
    a.add(JSON.parse(frames[0]));
    expect(() => a.add({ ...JSON.parse(frames[1]), id: 'bad' })).toThrow();
    // The original transfer's next frame is now unknown, too.
    expect(() => a.add(JSON.parse(frames[1]))).toThrow(/unknown transfer/);
  });
});

describe('newTransferId', () => {
  it('is 16 hex chars and unique', () => {
    const a = newTransferId();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(newTransferId()).not.toBe(a);
  });
});

describe('base64 helpers', () => {
  it('round-trip every byte value', () => {
    const all = new Uint8Array(256 * 3);
    for (let i = 0; i < all.length; i++) all[i] = i & 0xff;
    expect(base64ToBytes(bytesToBase64(all))).toEqual(all);
  });

  it('match the standard encoding', () => {
    expect(bytesToBase64(new TextEncoder().encode('hello'))).toBe('aGVsbG8=');
  });

  it('throw on invalid input', () => {
    expect(() => base64ToBytes('not base64!')).toThrow();
  });
});
