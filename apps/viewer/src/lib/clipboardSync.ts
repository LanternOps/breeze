/**
 * Clipboard sync v2 — one controller per WebRTC `clipboard` DataChannel.
 *
 * Speaks the agent protocol in agent/internal/remote/clipboard/sync.go (W4a,
 * #8240) and stays compatible with agents that predate it. Spec:
 * docs/superpowers/specs/remote-desktop/2026-10-07-viewer-input-clipboard-convenience-design.md §5.
 *
 * Agent → viewer:
 *   {type:"status", hostToViewer, viewerToHost, chunked, suppressesBaseline, changeNotices?, maxTextBytes, maxImageBytes}
 *   {type:"text", text} | {type:"image", image:<b64>, image_format} | {type:"rtf", ...}
 *   {type:"chunk", id, seq, total, data}  — any of the above, split (after hello)
 *   {type:"ack", hash, id?}               — sent after a viewer write was APPLIED
 *   {type:"unsupported", seq, empty?}     — the remote clipboard changed to content the agent
 *                                           does not send (a file, say), or was emptied;
 *                                           only after hello asked for changeNotices (#11310)
 * Viewer → agent:
 *   {type:"hello", chunked:true, changeNotices?:true} — only in reply to a chunk-capable status
 *   {type:"text", text} | {type:"image", image, image_format:"png"}, chunked when large
 *
 * Which clipboard wins a paste (#11310): the one that changed last. A remote
 * change the viewer did not write locally is "held"; the viewer remembers what
 * the local clipboard held when it arrived. At paste, a local clipboard that
 * still holds that is older than the remote's, so the paste keystroke goes
 * through without a push and pastes the remote's own clipboard; one that
 * holds something else changed afterwards, and is pushed first.
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
  /**
   * After a copy chord, how long a paste waits for a changeNotices agent to
   * report the copy: it reads within ~400 ms of the chord (#11310 row 4).
   */
  copySettleMs: 600,
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
  /** The agent reports every remote change, including ones it cannot carry, and reads promptly after a copy chord. */
  changeNotices: boolean;
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
  /**
   * The remote clipboard changed and the change was not written locally:
   * 'item' can be pulled, 'unsupported' cannot (a file, an image the agent
   * cannot read). null once the two clipboards agree again.
   */
  remoteHeld: 'item' | 'unsupported' | null;
}

/**
 * 'unreadable': the local clipboard held nothing the viewer can send — empty,
 * or a format the clipboard plugin cannot read (a file). The Tauri plugin
 * rejects both alike, so they cannot be told apart.
 */
export type PushFailure = 'too-large' | 'send-failed' | 'no-ack' | 'closed' | 'disabled' | 'unreadable';
export type PasteOutcome = { result: 'pasted' } | { result: 'failed'; reason: PushFailure };
export type SendOutcome =
  | { result: 'sent'; bytes: number }
  | { result: 'empty' }
  | { result: 'failed'; reason: PushFailure };

export interface ClipboardSyncOptions {
  channel: ClipboardChannelLike;
  io: LocalClipboardIO;
  hasFocus: () => boolean;
  /** When the operator last sent a key or click to the remote in this window. */
  lastInputAt: () => number | null;
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
    changeNotices: msg.changeNotices === true,
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
  /**
   * Fingerprints of what both clipboards are believed to hold. More than one:
   * a remote image written here reads back re-encoded, with a different hash
   * for the same picture.
   */
  private synced = new Set<string>();
  private remoteItem: { item: ClipItem; fp: string } | null = null;
  /**
   * The latest remote change that was not written locally, with the
   * fingerprints the local clipboard held when it arrived (empty when it held
   * nothing readable). null while both clipboards agree.
   */
  private held: { kind: 'item' | 'unsupported'; localAtChange: Set<string> } | null = null;
  /** When the latest remote change (content or notice) arrived. */
  private lastRemoteChangeAt: number | null = null;
  /** Numbers remote changes in arrival order. */
  private remoteChangeSeq = 0;
  /**
   * Remote changes up to this number are older than a push the agent has
   * since acked (the channel is ordered), so the remote holds our write and
   * they must not be held or applied when their bookkeeping finishes late.
   */
  private supersededThrough = 0;
  private readonly remoteChangeWaiters = new Set<() => void>();
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
      remoteHeld: this.held?.kind ?? null,
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
    this.wakeRemoteChangeWaiters();
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
            this.channel.send(JSON.stringify(this.status.changeNotices
              ? { type: 'hello', chunked: true, changeNotices: true }
              : { type: 'hello', chunked: true }));
          } catch (err) {
            console.warn('[clipboard] hello failed:', err);
          }
        }
        this.emit();
        return;
      case 'ack':
        if (typeof msg.hash === 'string') this.resolveAck(msg.hash);
        return;
      case 'unsupported':
        if (this.status?.changeNotices) this.handleChangeNotice(msg.empty === true);
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
    // Decided on arrival: focus and input recency move while the content is hashed.
    const decision = remoteClipboardDecision({
      now: this.now(),
      hasFocus: this.opts.hasFocus(),
      lastInputAt: this.opts.lastInputAt(),
      lastCopyIntentAt: this.opts.lastCopyIntentAt(),
      channelOpenedAt: this.openedAt,
      pushesSeen,
      suppressesBaseline: this.status?.suppressesBaseline ?? false,
    });
    const gen = decision === 'skip-baseline' ? 0 : this.noteRemoteChange();
    this.inbound = this.inbound.then(async () => {
      if (gen !== 0 && gen <= this.supersededThrough) return;
      if (!item) {
        // A format this viewer cannot hold (RTF, an unknown image format,
        // over the cap): nothing to write, but the remote is now newer.
        if (decision === 'skip-baseline') return;
        this.remoteItem = null;
        await this.holdRemoteChange(gen, 'unsupported');
        return;
      }
      const fp = await fingerprintItem(item);
      this.remoteItem = { item, fp };
      if (decision === 'skip-baseline') {
        // What the end user had before the session: on offer, never pasted
        // over the operator's clipboard and never a reason to hold a paste.
        this.held = null;
        this.markSynced(fp);
        this.emit();
        return;
      }
      if (decision === 'apply') {
        this.markSynced(fp);
        if (await this.writeLocal(item, fp)) return;
      } else {
        console.debug('[clipboard] remote clipboard held:', decision);
      }
      await this.holdRemoteChange(gen, 'item', fp);
    });
  }

  /** {type:"unsupported"}: the remote clipboard changed to something the agent does not send, or was emptied. */
  private handleChangeNotice(empty: boolean): void {
    this.pushesSeen++;
    const gen = this.noteRemoteChange();
    this.inbound = this.inbound.then(async () => {
      if (gen <= this.supersededThrough) return;
      this.remoteItem = null;
      if (empty) {
        // Nothing on the remote to protect: the next paste sends the local clipboard.
        this.held = null;
        this.synced = new Set();
        this.emit();
        return;
      }
      await this.holdRemoteChange(gen, 'unsupported');
    });
  }

  private noteRemoteChange(): number {
    this.lastRemoteChangeAt = this.now();
    this.wakeRemoteChangeWaiters();
    return ++this.remoteChangeSeq;
  }

  /** Our push is on the remote now, after every remote change received so far. */
  private notePushApplied(fp: string): void {
    this.markSynced(fp);
    this.held = null;
    this.supersededThrough = this.remoteChangeSeq;
  }

  private wakeRemoteChangeWaiters(): void {
    const waiters = [...this.remoteChangeWaiters];
    this.remoteChangeWaiters.clear();
    for (const w of waiters) w();
  }

  /**
   * Records a remote change that was not written locally, and what the local
   * clipboard held when it arrived. A remote item the local clipboard already
   * holds is no change at all for the operator: nothing is held.
   *
   * A local read that fails here leaves the set empty, so any readable local
   * clipboard at paste time counts as newer. That is right for the common case
   * (a file on the local clipboard, then a copy) and wrong only for a
   * transient read failure.
   */
  private async holdRemoteChange(gen: number, kind: 'item' | 'unsupported', remoteFp?: string): Promise<void> {
    const local = await this.readLocal();
    const localFp = local ? await fingerprintItem(local) : null;
    // A push acked while the local clipboard was being read is newer.
    if (gen <= this.supersededThrough) return;
    if (remoteFp !== undefined && localFp === remoteFp) {
      this.held = null;
      this.markSynced(remoteFp);
    } else {
      this.held = { kind, localAtChange: localFp ? new Set([localFp]) : new Set() };
    }
    this.emit();
  }

  private markSynced(fp: string): void {
    this.synced = new Set([fp]);
  }

  /** Writes a remote item to the local clipboard. Only the input-recency rule or an explicit action calls this. */
  private async writeLocal(item: ClipItem, fp: string): Promise<boolean> {
    try {
      if (item.type === 'text') await this.io.writeText(item.text);
      else await this.io.writeImage(item.image, item.format);
    } catch (err) {
      console.warn('[clipboard] failed to write remote→local:', err);
      return false;
    }
    // Both clipboards hold this item now, unless a newer remote change came in
    // meanwhile (the inbound chain runs one change at a time, so only an
    // explicit pull can race one).
    if (this.remoteItem?.fp === fp) {
      this.held = null;
      this.markSynced(fp);
    }
    // The local clipboard re-encodes an image, so a paste would read back
    // different bytes and upload the same picture again. Record the read-back
    // too — but only while the remote still holds this item.
    if (item.type === 'image' && this.synced.has(fp)) {
      try {
        const back = await this.io.readImagePng();
        if (back && back.length > 0 && this.synced.has(fp)) {
          this.synced.add(await fingerprintItem({ type: 'image', image: back, format: 'png' }));
        }
      } catch {
        // Best effort: without it the next paste re-sends, which is still correct.
      }
    }
    this.lastTransfer = { direction: 'from-remote', type: item.type, bytes: itemBytes(item), at: this.now() };
    this.emit();
    return true;
  }

  /** "Copy remote clipboard" / the held badge: applies the latest remote item, e.g. one that was held. */
  async copyRemoteClipboard(): Promise<boolean> {
    await this.inbound;
    if (!this.remoteItem) return false;
    return this.writeLocal(this.remoteItem.item, this.remoteItem.fp);
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
      this.notePushApplied(fp);
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
    this.notePushApplied(fp);
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
   *
   * Push or not is decided by change order (#11310): the local clipboard is
   * pushed only when it changed after the last remote change, so a newer
   * remote clipboard (held, or one the viewer cannot hold, such as a file) is
   * pasted as it is. A local clipboard with nothing readable cancels the
   * keystroke: dispatching it would silently paste the remote's clipboard
   * instead of what the operator copied.
   */
  pasteTransaction(dispatch: () => void): Promise<PasteOutcome> {
    return this.enqueue(async () => {
      const status = this.status;
      if (this.closed || this.channel.readyState !== 'open') {
        // An agent that acks had a working channel, and this paste may be one
        // queued behind a push the close cancelled: the keystroke would land
        // on whatever input path is current, pasting stale content.
        if (status) return { result: 'failed', reason: 'closed' } as const;
        dispatch();
        return { result: 'pasted' } as const;
      }
      // Disabled by policy: the agent would drop the push. Ctrl+V still pastes
      // the remote's own clipboard, so the keystroke goes through.
      if (status && !status.viewerToHost) {
        dispatch();
        return { result: 'pasted' } as const;
      }
      await this.awaitCopySettle();
      // Every remote change that has arrived is accounted for before deciding.
      await this.inbound;
      if (status && this.closed) return { result: 'failed', reason: 'closed' } as const;
      const item = await this.readLocal();
      if (!item) {
        // Nothing readable here. If the remote changed while the local
        // clipboard was already unreadable, the remote's is the newer one
        // (a file on both sides, say): paste it. Otherwise the remote holds
        // older content than what the operator copied, so refuse. A change
        // from one unreadable item to another cannot be seen.
        if (this.held && this.held.localAtChange.size === 0) {
          dispatch();
          return { result: 'pasted' } as const;
        }
        return { result: 'failed', reason: 'unreadable' } as const;
      }
      const fp = await fingerprintItem(item);
      if (!this.localIsNewer(fp, status)) {
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

  /** Whether the local clipboard (fingerprint fp) changed after the remote's last change, so a paste must push it. */
  private localIsNewer(fp: string, status: ClipboardAgentStatus | null): boolean {
    if (this.held) return !this.held.localAtChange.has(fp);
    // With host→viewer off, a remote copy since the last sync is invisible here.
    if (status && !status.hostToViewer) return true;
    return !this.synced.has(fp);
  }

  /**
   * Right after a copy chord, waits (briefly) for a changeNotices agent to
   * report the copy, so a quick Ctrl+C, Ctrl+V on the remote does not push the
   * older local clipboard over the fresh copy (#11310 row 4). Agents without
   * change notices poll at 500 ms and are not waited for, as before.
   */
  private async awaitCopySettle(): Promise<void> {
    if (!this.status?.changeNotices) return;
    const copyAt = this.opts.lastCopyIntentAt();
    if (copyAt === null) return;
    if (this.lastRemoteChangeAt !== null && this.lastRemoteChangeAt >= copyAt) return;
    const remaining = copyAt + this.timings.copySettleMs - this.now();
    if (remaining <= 0) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.remoteChangeWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, remaining);
      this.remoteChangeWaiters.add(done);
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
