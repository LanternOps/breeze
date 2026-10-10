/**
 * Clipboard chunk transport — TypeScript port of the agent's
 * agent/internal/remote/clipboard/chunk.go (W4a, #8240). Keep the constants and
 * checks identical: each end rejects what the other's limits would let through.
 *
 * A clipboard message whose JSON is larger than one frame is split into
 *
 *   {"type":"chunk","id":"<transfer>","seq":n,"total":N,"data":"<base64 piece>"}
 *
 * and the receiver concatenates the pieces and handles the result exactly as if
 * it had arrived whole. SCTP's per-message limit (65,535 bytes when the peer
 * does not advertise one) is why a real image never fitted in one message.
 */

/** Raw bytes per piece; ~43.7 KiB of base64 plus the envelope. */
export const CHUNK_PIECE_BYTES = 32 * 1024;
/** The most any frame may serialize to. */
export const CHUNK_FRAME_MAX_BYTES = 48 * 1024;
/** Bound on a reassembled message: an 8 MiB image as base64 is ~10.7 MiB, plus JSON. */
export const MAX_ASSEMBLED_BYTES = 12 * 1024 * 1024;
/**
 * A transfer with no frame for this long is dropped. Inactivity, not total
 * duration: a full image over a slow uplink legitimately takes minutes.
 */
export const CHUNK_TRANSFER_TIMEOUT_MS = 30_000;
/** Bound on the transfer id; it is echoed in the ack. */
export const MAX_TRANSFER_ID_BYTES = 64;

const MAX_TOTAL_FRAMES = Math.floor(MAX_ASSEMBLED_BYTES / CHUNK_PIECE_BYTES) + 1;

export interface ChunkFrame {
  type: 'chunk';
  id: string;
  seq: number;
  total: number;
  data: string;
}

export function newTransferId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function bytesToBase64(bytes: Uint8Array): string {
  // String.fromCharCode over a spread is bounded by the engine's argument
  // limit, so build the binary string in slices.
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)));
  }
  return btoa(binary);
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict standard base64 (padded), matching Go's base64.StdEncoding. */
export function base64ToBytes(s: string): Uint8Array {
  if (s.length % 4 !== 0 || !BASE64_RE.test(s)) throw new Error('invalid base64');
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Splits inner (the UTF-8 JSON of one clipboard message) into serialized frames. */
export function encodeChunks(id: string, inner: Uint8Array): string[] {
  if (inner.length > MAX_ASSEMBLED_BYTES) {
    throw new Error(`clipboard message exceeds maximum ${MAX_ASSEMBLED_BYTES} bytes`);
  }
  const total = Math.max(1, Math.ceil(inner.length / CHUNK_PIECE_BYTES));
  const frames: string[] = [];
  for (let seq = 0; seq < total; seq++) {
    const piece = inner.subarray(seq * CHUNK_PIECE_BYTES, (seq + 1) * CHUNK_PIECE_BYTES);
    const frame: ChunkFrame = { type: 'chunk', id, seq, total, data: bytesToBase64(piece) };
    frames.push(JSON.stringify(frame));
  }
  return frames;
}

/**
 * Rebuilds one transfer at a time. A frame with seq 0 starts a new transfer and
 * discards any partial one, so an abandoned transfer costs at most one buffer.
 * The clipboard channel is ordered and reliable, so anything out of sequence
 * is an error, not a reordering to repair. Any error resets the assembler.
 */
export class ChunkAssembler {
  private id = '';
  private next = 0;
  private total = 0;
  private parts: Uint8Array[] = [];
  private size = 0;
  private lastFrameAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private reset(): void {
    this.id = '';
    this.next = 0;
    this.total = 0;
    this.parts = [];
    this.size = 0;
  }

  private fail(msg: string): never {
    this.reset();
    throw new Error(msg);
  }

  /** Consumes f. Returns the reassembled message when f was the last piece, else null. */
  add(f: ChunkFrame): Uint8Array | null {
    if (
      typeof f.id !== 'string' || f.id === '' || utf8Length(f.id) > MAX_TRANSFER_ID_BYTES ||
      !Number.isInteger(f.total) || f.total < 1 || f.total > MAX_TOTAL_FRAMES ||
      !Number.isInteger(f.seq) || f.seq < 0 || f.seq >= f.total
    ) {
      this.fail('invalid clipboard chunk header');
    }
    if (f.seq === 0) {
      this.reset();
      this.id = f.id;
      this.total = f.total;
      this.lastFrameAt = this.now();
    } else if (f.id !== this.id) {
      this.fail('clipboard chunk for an unknown transfer');
    }
    if (this.now() - this.lastFrameAt > CHUNK_TRANSFER_TIMEOUT_MS) {
      this.fail('clipboard transfer timed out');
    }
    this.lastFrameAt = this.now(); // inactivity, not total duration
    if (f.seq !== this.next || f.total !== this.total) {
      this.fail('clipboard chunk out of sequence');
    }
    let piece: Uint8Array;
    try {
      piece = base64ToBytes(typeof f.data === 'string' ? f.data : '');
    } catch {
      this.fail('clipboard chunk data: invalid base64');
    }
    if (piece.length > CHUNK_PIECE_BYTES || this.size + piece.length > MAX_ASSEMBLED_BYTES) {
      this.fail('clipboard chunk exceeds size limits');
    }
    this.parts.push(piece);
    this.size += piece.length;
    this.next++;
    if (this.next < this.total) return null;

    const out = new Uint8Array(this.size);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    this.reset();
    return out;
  }
}
