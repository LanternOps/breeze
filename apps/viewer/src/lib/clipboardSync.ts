/**
 * Clipboard sync v2 — one controller per WebRTC `clipboard` DataChannel.
 *
 * Speaks the agent protocol in agent/internal/remote/clipboard/sync.go (W4a,
 * #8240) and stays compatible with agents that predate it. Spec:
 * docs/superpowers/specs/remote-desktop/2026-10-07-viewer-input-clipboard-convenience-design.md §5.
 *
 * Agent → viewer:
 *   {type:"status", hostToViewer, viewerToHost, chunked, suppressesBaseline, maxTextBytes, maxImageBytes}
 *   {type:"text", text} | {type:"image", image:<b64>, image_format} | {type:"rtf", ...}
 *   {type:"chunk", id, seq, total, data}  — any of the above, split (after hello)
 *   {type:"ack", hash, id?}               — sent after a viewer write was APPLIED
 * Viewer → agent:
 *   {type:"hello", chunked:true}          — only in reply to a chunk-capable status
 *   {type:"text", text} | {type:"image", image, image_format:"png"}, chunked when large
 *
 * Why hello waits for status: an agent that predates W4a hands every non-ack
 * message to its clipboard write path, and the Windows provider empties the
 * clipboard before it rejects an unknown type. A hello sent on open would wipe
 * the end user's clipboard on every old Windows agent.
 */
import {
  CHUNK_FRAME_MAX_BYTES,
  MAX_ASSEMBLED_BYTES,
  ChunkAssembler,
  base64ToBytes,
  bytesToBase64,
  encodeChunks,
  newTransferId,
  type ChunkFrame,
} from './clipboardChunk';
import { remoteClipboardDecision } from './inputSafety';

/** The agent's content caps (agent/internal/remote/clipboard/clipboard.go). */
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** An agent that predates chunking rejects any single message over this (maxClipboardMessageBytes). */
export const LEGACY_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
/** A chunked send pauses while this much is queued, as the agent does (chunkBufferHighWater). */
export const CLIPBOARD_BUFFER_HIGH_WATER = 1024 * 1024;

const DEFAULT_TIMINGS = {
  /** W1's wait for an agent that may never ack; the paste goes ahead regardless. */
  legacyAckMs: 300,
  /** How long an ack-capable agent gets, once the channel buffer has drained. */
  ackMs: 3_000,
  /** Per-frame bound on waiting for the SCTP buffer, matching the agent's chunk timeout. */
  bufferWaitMs: 30_000,
  pollMs: 10,
};

export type ImageFormat = 'png' | 'jpeg';

export type ClipItem =
  | { type: 'text'; text: string }
  | { type: 'image'; image: Uint8Array; format: ImageFormat };

export interface LocalClipboardIO {
  readText(): Promise<string | null>;
  /** The local clipboard image encoded as PNG, or null when it holds none. */
  readImagePng(): Promise<Uint8Array | null>;
  writeText(text: string): Promise<void>;
  writeImage(bytes: Uint8Array, format: ImageFormat): Promise<void>;
}

/** The parts of RTCDataChannel the controller uses. */
export interface ClipboardChannelLike {
  readonly readyState: string;
  readonly bufferedAmount: number;
  send(data: string): void;
  addEventListener(type: string, cb: (e: Event) => void): void;
  removeEventListener(type: string, cb: (e: Event) => void): void;
}

export interface ClipboardAgentStatus {
  hostToViewer: boolean;
  viewerToHost: boolean;
  chunked: boolean;
  suppressesBaseline: boolean;
  maxTextBytes: number;
  maxImageBytes: number;
}

export interface ClipboardTransfer {
  direction: 'from-remote' | 'to-remote';
  type: ClipItem['type'];
  bytes: number;
  at: number;
}

export interface ClipboardSyncState {
  open: boolean;
  /** null until the agent reports it; agents that predate W4a never do. */
  status: ClipboardAgentStatus | null;
  lastTransfer: ClipboardTransfer | null;
  /** A remote item is held for "Copy remote clipboard". */
  remoteItemAvailable: boolean;
}

export type PushFailure = 'too-large' | 'send-failed' | 'no-ack' | 'closed' | 'disabled';
export type PasteOutcome = { result: 'pasted' } | { result: 'failed'; reason: PushFailure };
export type SendOutcome =
  | { result: 'sent'; bytes: number }
  | { result: 'empty' }
  | { result: 'failed'; reason: PushFailure };

export interface ClipboardSyncOptions {
  channel: ClipboardChannelLike;
  io: LocalClipboardIO;
  hasFocus: () => boolean;
  lastCopyIntentAt: () => number | null;
  now?: () => number;
  onChange?: (state: ClipboardSyncState) => void;
  timings?: Partial<typeof DEFAULT_TIMINGS>;
}

type AckOutcome = 'ack' | 'timeout' | 'closed';

class ChannelClosedError extends Error {
  constructor() { super('clipboard channel closed'); }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function itemBytes(item: ClipItem): number {
  return item.type === 'text' ? textEncoder.encode(item.text).length : item.image.length;
}

/** The agent's fingerprint: hex sha256(type ‖ text ‖ rtf ‖ image ‖ image_format). */
export async function fingerprintItem(item: ClipItem): Promise<string> {
  const parts: Uint8Array[] = item.type === 'text'
    ? [textEncoder.encode('text'), textEncoder.encode(item.text)]
    : [textEncoder.encode('image'), item.image, textEncoder.encode(item.format)];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.length; }
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function parseStatus(msg: Record<string, unknown>): ClipboardAgentStatus {
  const cap = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, fallback) : fallback;
  return {
    hostToViewer: msg.hostToViewer === true,
    viewerToHost: msg.viewerToHost === true,
    chunked: msg.chunked === true,
    suppressesBaseline: msg.suppressesBaseline === true,
    maxTextBytes: cap(msg.maxTextBytes, MAX_TEXT_BYTES),
    maxImageBytes: cap(msg.maxImageBytes, MAX_IMAGE_BYTES),
  };
}

/** A remote content message → an item the viewer can write, or null for anything else. */
function parseRemoteItem(msg: Record<string, unknown>): ClipItem | null {
  if (msg.type === 'text') {
    if (typeof msg.text !== 'string' || msg.text === '') return null;
    if (textEncoder.encode(msg.text).length > MAX_TEXT_BYTES) return null;
    return { type: 'text', text: msg.text };
  }
  if (msg.type === 'image') {
    if (typeof msg.image !== 'string' || msg.image === '') return null;
    if (msg.image_format !== 'png' && msg.image_format !== 'jpeg') return null;
    let image: Uint8Array;
    try {
      image = base64ToBytes(msg.image);
    } catch {
      return null;
    }
    if (image.length > MAX_IMAGE_BYTES) return null;
    return { type: 'image', image, format: msg.image_format };
  }
  return null;
}

const CONTENT_TYPES = new Set(['text', 'image', 'rtf']);

export class ClipboardSync {
  private readonly channel: ClipboardChannelLike;
  private readonly io: LocalClipboardIO;
  private readonly opts: ClipboardSyncOptions;
  private readonly now: () => number;
  private readonly timings: typeof DEFAULT_TIMINGS;
  private readonly openedAt: number;
  private readonly assembler: ChunkAssembler;

  private closed = false;
  private status: ClipboardAgentStatus | null = null;
  private helloSent = false;
  private pushesSeen = 0;
  /** Fingerprint of what both clipboards are believed to hold. */
  private lastSyncedFp = '';
  private remoteItem: ClipItem | null = null;
  private lastTransfer: ClipboardTransfer | null = null;
  private readonly ackWaiters = new Map<string, Array<(o: AckOutcome) => void>>();
  private queue: Promise<unknown> = Promise.resolve();
  private inbound: Promise<unknown> = Promise.resolve();

  private readonly onMessage = (e: Event) => this.handleMessage((e as MessageEvent).data);
  private readonly onClose = () => this.close();

  constructor(opts: ClipboardSyncOptions) {
    this.opts = opts;
    this.channel = opts.channel;
    this.io = opts.io;
    this.now = opts.now ?? Date.now;
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.openedAt = this.now();
    this.assembler = new ChunkAssembler(this.now);
    this.channel.addEventListener('message', this.onMessage);
    this.channel.addEventListener('close', this.onClose);
  }

  get state(): ClipboardSyncState {
    return {
      open: !this.closed,
      status: this.status,
      lastTransfer: this.lastTransfer,
      remoteItemAvailable: this.remoteItem !== null,
    };
  }

  private emit(): void {
    this.opts.onChange?.(this.state);
  }

  /** Ends this channel's session: pending acks fail and nothing queued may paste. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.removeEventListener('message', this.onMessage);
    this.channel.removeEventListener('close', this.onClose);
    for (const waiters of this.ackWaiters.values()) for (const w of waiters) w('closed');
    this.ackWaiters.clear();
    this.emit();
  }

  // ── inbound ─────────────────────────────────────────────────────────

  private handleMessage(data: unknown): void {
    if (this.closed || typeof data !== 'string') return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      console.warn('[clipboard] unparseable message from agent');
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'status':
        this.status = parseStatus(msg);
        if (this.status.chunked && !this.helloSent) {
          this.helloSent = true;
          try {
            this.channel.send(JSON.stringify({ type: 'hello', chunked: true }));
          } catch (err) {
            console.warn('[clipboard] hello failed:', err);
          }
        }
        this.emit();
        return;
      case 'ack':
        if (typeof msg.hash === 'string') this.resolveAck(msg.hash);
        return;
      case 'chunk': {
        let inner: Uint8Array | null;
        try {
          inner = this.assembler.add(msg as unknown as ChunkFrame);
        } catch (err) {
          console.warn('[clipboard] dropped chunked transfer:', err instanceof Error ? err.message : err);
          return;
        }
        if (!inner) return;
        let whole: Record<string, unknown>;
        try {
          whole = JSON.parse(textDecoder.decode(inner));
        } catch {
          console.warn('[clipboard] chunked transfer did not decode');
          return;
        }
        if (whole && CONTENT_TYPES.has(whole.type as string)) this.handleRemoteContent(whole);
        return;
      }
      default:
        if (CONTENT_TYPES.has(msg.type as string)) this.handleRemoteContent(msg);
    }
  }

  private handleRemoteContent(msg: Record<string, unknown>): void {
    // Every push counts toward the baseline, whatever its format: an image or
    // empty baseline must not make the next real copy look like the baseline.
    const pushesSeen = this.pushesSeen++;
    const item = parseRemoteItem(msg);
    if (!item) return;
    // Decided on arrival: focus may move while the content is hashed.
    const decision = remoteClipboardDecision({
      now: this.now(),
      hasFocus: this.opts.hasFocus(),
      lastCopyIntentAt: this.opts.lastCopyIntentAt(),
      channelOpenedAt: this.openedAt,
      pushesSeen,
      suppressesBaseline: this.status?.suppressesBaseline ?? false,
    });
    this.remoteItem = item;
    this.inbound = this.inbound.then(async () => {
      this.lastSyncedFp = await fingerprintItem(item);
      if (decision === 'apply') {
        await this.writeLocal(item);
      } else {
        console.debug('[clipboard] remote clipboard not applied:', decision);
        this.emit();
      }
    });
  }

  /** Writes a remote item to the local clipboard. Only the focus rule or an explicit action calls this. */
  private async writeLocal(item: ClipItem): Promise<boolean> {
    try {
      if (item.type === 'text') await this.io.writeText(item.text);
      else await this.io.writeImage(item.image, item.format);
    } catch (err) {
      console.warn('[clipboard] failed to write remote→local:', err);
      return false;
    }
    this.lastTransfer = { direction: 'from-remote', type: item.type, bytes: itemBytes(item), at: this.now() };
    this.emit();
    return true;
  }

  /** "Copy remote clipboard": applies the latest remote item, e.g. one a background window skipped. */
  async copyRemoteClipboard(): Promise<boolean> {
    await this.inbound;
    if (!this.remoteItem) return false;
    return this.writeLocal(this.remoteItem);
  }

  // ── outbound ────────────────────────────────────────────────────────

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private resolveAck(hash: string): void {
    const waiters = this.ackWaiters.get(hash);
    if (!waiters) {
      console.debug('[clipboard] ack for unknown hash:', hash);
      return;
    }
    this.ackWaiters.delete(hash);
    for (const w of waiters) w('ack');
  }

  /** Registered before the send, so an ack can never arrive unobserved. */
  private expectAck(hash: string): { wait: (timeoutMs: number) => Promise<AckOutcome>; cancel: () => void } {
    let settle!: (o: AckOutcome) => void;
    const outcome = new Promise<AckOutcome>((resolve) => { settle = resolve; });
    let done = false;
    const waiter = (o: AckOutcome) => { if (!done) { done = true; settle(o); } };
    const list = this.ackWaiters.get(hash) ?? [];
    list.push(waiter);
    this.ackWaiters.set(hash, list);
    const remove = () => {
      const l = this.ackWaiters.get(hash);
      if (!l) return;
      const rest = l.filter((w) => w !== waiter);
      if (rest.length) this.ackWaiters.set(hash, rest);
      else this.ackWaiters.delete(hash);
    };
    return {
      wait: (timeoutMs) => {
        if (this.closed) waiter('closed');
        const timer = setTimeout(() => waiter('timeout'), timeoutMs);
        return outcome.then((o) => { clearTimeout(timer); remove(); return o; });
      },
      cancel: () => { waiter('closed'); remove(); },
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Waits until at most `limit` bytes are queued on the channel. */
  private async waitForBuffer(limit: number): Promise<void> {
    const deadline = this.now() + this.timings.bufferWaitMs;
    for (;;) {
      if (this.closed || this.channel.readyState !== 'open') throw new ChannelClosedError();
      if (this.channel.bufferedAmount <= limit) return;
      if (this.now() > deadline) throw new Error('clipboard channel buffer did not drain');
      await this.sleep(this.timings.pollMs);
    }
  }

  private async sendChunked(json: string): Promise<void> {
    const frames = encodeChunks(newTransferId(), textEncoder.encode(json));
    for (const frame of frames) {
      await this.waitForBuffer(CLIPBOARD_BUFFER_HIGH_WATER);
      this.channel.send(frame);
    }
  }

  private async readLocal(): Promise<ClipItem | null> {
    try {
      const text = await this.io.readText();
      if (text) return { type: 'text', text };
    } catch (err) {
      console.warn('[clipboard] local text read failed:', err);
    }
    try {
      const png = await this.io.readImagePng();
      if (png && png.length > 0) return { type: 'image', image: png, format: 'png' };
    } catch (err) {
      console.warn('[clipboard] local image read failed:', err);
    }
    return null;
  }

  /**
   * Sends one local item. With an agent that sent status the result is only
   * 'ok' once the agent acked it as applied; with an older agent, once sent.
   */
  private async push(item: ClipItem, fp: string): Promise<'ok' | PushFailure> {
    const status = this.status;
    const bytes = itemBytes(item);
    if (bytes > (item.type === 'text' ? status?.maxTextBytes ?? MAX_TEXT_BYTES : status?.maxImageBytes ?? MAX_IMAGE_BYTES)) {
      return 'too-large';
    }
    const json = JSON.stringify(item.type === 'text'
      ? { type: 'text', text: item.text }
      : { type: 'image', image: bytesToBase64(item.image), image_format: item.format });
    const jsonBytes = textEncoder.encode(json).length;
    const chunk = status?.chunked === true && jsonBytes > CHUNK_FRAME_MAX_BYTES;
    if (chunk ? jsonBytes > MAX_ASSEMBLED_BYTES : jsonBytes > LEGACY_MAX_MESSAGE_BYTES) return 'too-large';

    const ack = this.expectAck(fp);
    try {
      if (chunk) await this.sendChunked(json);
      else this.channel.send(json);
    } catch (err) {
      ack.cancel();
      if (err instanceof ChannelClosedError) return 'closed';
      // Throws when the channel is closing, or when the payload exceeds the
      // SCTP max message size.
      console.warn('[clipboard] send failed:', err);
      return 'send-failed';
    }

    if (!status) {
      // Agents that predate the ack exist: cache on send and go ahead after a
      // short wait whatever happens (W1 behaviour).
      this.lastSyncedFp = fp;
      this.lastTransfer = { direction: 'to-remote', type: item.type, bytes, at: this.now() };
      this.emit();
      await ack.wait(this.timings.legacyAckMs);
      return 'ok';
    }

    try {
      // The ack clock starts once the frames have actually left.
      await this.waitForBuffer(0);
    } catch (err) {
      ack.cancel();
      return err instanceof ChannelClosedError ? 'closed' : 'no-ack';
    }
    const outcome = await ack.wait(this.timings.ackMs);
    if (outcome !== 'ack' || this.closed) return outcome === 'timeout' ? 'no-ack' : 'closed';
    this.lastSyncedFp = fp;
    this.lastTransfer = { direction: 'to-remote', type: item.type, bytes, at: this.now() };
    this.emit();
    return 'ok';
  }

  /**
   * Paste as a transaction: the local clipboard reaches the remote first, and
   * the paste keystroke is dispatched only when it did. With an agent that
   * acks, a failed send, an ack timeout or a channel close cancels the
   * keystroke instead of pasting stale content. Pastes run one at a time, and
   * a controller closed mid-paste never dispatches, so a paste cannot land in
   * a session the operator moved on to.
   */
  pasteTransaction(dispatch: () => void): Promise<PasteOutcome> {
    return this.enqueue(async () => {
      if (this.closed || this.channel.readyState !== 'open') {
        dispatch();
        return { result: 'pasted' } as const;
      }
      const status = this.status;
      // Disabled by policy: the agent would drop the push. Ctrl+V still pastes
      // the remote's own clipboard, so the keystroke goes through.
      if (status && !status.viewerToHost) {
        dispatch();
        return { result: 'pasted' } as const;
      }
      const item = await this.readLocal();
      if (!item) {
        dispatch();
        return { result: 'pasted' } as const;
      }
      const fp = await fingerprintItem(item);
      // Skip what the remote already holds — but only while host→viewer is on.
      // With it off, a remote copy since the last sync is invisible here.
      if (fp === this.lastSyncedFp && (!status || status.hostToViewer)) {
        dispatch();
        return { result: 'pasted' } as const;
      }
      const res = await this.push(item, fp);
      if (res !== 'ok') return { result: 'failed', reason: res } as const;
      if (status && this.closed) return { result: 'failed', reason: 'closed' } as const;
      if (!status && this.channel.readyState !== 'open') {
        console.warn('[clipboard] DataChannel closed after clipboard push');
      }
      dispatch();
      return { result: 'pasted' } as const;
    });
  }

  /** "Send clipboard to remote": pushes the local clipboard with no keystroke. */
  sendLocalClipboard(): Promise<SendOutcome> {
    return this.enqueue(async () => {
      if (this.closed || this.channel.readyState !== 'open') return { result: 'failed', reason: 'closed' } as const;
      if (this.status && !this.status.viewerToHost) return { result: 'failed', reason: 'disabled' } as const;
      const item = await this.readLocal();
      if (!item) return { result: 'empty' } as const;
      const res = await this.push(item, await fingerprintItem(item));
      if (res !== 'ok') return { result: 'failed', reason: res } as const;
      return { result: 'sent', bytes: itemBytes(item) } as const;
    });
  }
}
