import { describe, it, expect, vi } from 'vitest';
import {
  ClipboardSync,
  CLIPBOARD_BUFFER_HIGH_WATER,
  LEGACY_MAX_MESSAGE_BYTES,
  type LocalClipboardIO,
  type ClipboardChannelLike,
} from './clipboardSync';
import { CHUNK_FRAME_MAX_BYTES, encodeChunks, bytesToBase64, base64ToBytes, ChunkAssembler } from './clipboardChunk';
import { REMOTE_CLIPBOARD_BASELINE_WINDOW_MS } from './inputSafety';

// ── fakes ────────────────────────────────────────────────────────────────

class FakeChannel extends EventTarget implements ClipboardChannelLike {
  readyState: string = 'open';
  bufferedAmount = 0;
  sent: string[] = [];
  sendImpl: ((s: string) => void) | null = null;
  send(s: string): void {
    if (this.sendImpl) this.sendImpl(s);
    this.sent.push(s);
  }
  deliver(obj: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: typeof obj === 'string' ? obj : JSON.stringify(obj) }));
  }
  closeNow(): void {
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
  sentJson(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function fakeIO(local: { text?: string | null; image?: Uint8Array | null } = {}) {
  const io = {
    text: local.text ?? null,
    image: local.image ?? null,
    readText: vi.fn(async () => io.text),
    readImagePng: vi.fn(async () => io.image),
    writeText: vi.fn(async (_t: string) => {}),
    writeImage: vi.fn(async (_b: Uint8Array, _f: 'png' | 'jpeg') => {}),
  };
  return io as typeof io & LocalClipboardIO;
}

/** The agent's fingerprint: sha256(type ‖ text ‖ rtf ‖ image ‖ image_format), hex. */
// Written out independently of fingerprintItem so a drift from the agent shows.
async function agentHash(type: string, text: string, image: Uint8Array = new Uint8Array(0), format = ''): Promise<string> {
  const enc = new TextEncoder();
  const buf = new Uint8Array([...enc.encode(type), ...enc.encode(text), ...image, ...enc.encode(format)]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Remote content is fingerprinted (crypto.subtle, async) before it is applied.
const flush = () => new Promise<void>((r) => setTimeout(r, 15));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const W4A_STATUS = {
  type: 'status', hostToViewer: true, viewerToHost: true, chunked: true,
  suppressesBaseline: true, maxTextBytes: 1024 * 1024, maxImageBytes: 8 * 1024 * 1024,
};

function setup(opts: {
  local?: { text?: string | null; image?: Uint8Array | null };
  focused?: boolean;
  /** When the operator last sent a key or click; 'now' (default) is always recent. */
  inputAt?: number | null | 'now';
  copyIntentAt?: number | null;
  status?: Record<string, unknown> | null;
  now?: () => number;
  copySettleMs?: number;
} = {}) {
  const channel = new FakeChannel();
  const io = fakeIO(opts.local);
  let focused = opts.focused ?? true;
  let inputAt = opts.inputAt === undefined ? 'now' : opts.inputAt;
  let copyIntentAt = opts.copyIntentAt ?? null;
  const clock = opts.now ?? Date.now;
  const onChange = vi.fn();
  const sync = new ClipboardSync({
    channel,
    io,
    hasFocus: () => focused,
    lastInputAt: () => (inputAt === 'now' ? clock() : inputAt),
    lastCopyIntentAt: () => copyIntentAt,
    now: opts.now,
    onChange,
    timings: { legacyAckMs: 30, ackMs: 60, bufferWaitMs: 80, pollMs: 2, copySettleMs: opts.copySettleMs ?? 200 },
  });
  if (opts.status !== null) channel.deliver(opts.status ?? W4A_STATUS);
  return {
    channel, io, sync, onChange,
    setFocused: (f: boolean) => { focused = f; },
    setInputAt: (t: number | null | 'now') => { inputAt = t; },
    setCopyIntentAt: (t: number | null) => { copyIntentAt = t; },
  };
}

const NOTICES_STATUS = { ...W4A_STATUS, changeNotices: true };

/** Acks every content message the viewer sends, the way a W4a agent does. */
function autoAck(channel: FakeChannel): void {
  const rx = new ChunkAssembler();
  channel.sendImpl = (s) => {
    const msg = JSON.parse(s);
    let payload = msg;
    if (msg.type === 'chunk') {
      const inner = rx.add(msg);
      if (!inner) return;
      payload = JSON.parse(new TextDecoder().decode(inner));
    }
    if (payload.type === 'text') {
      void agentHash('text', payload.text).then((hash) => channel.deliver({ type: 'ack', hash }));
    } else if (payload.type === 'image') {
      void agentHash('image', '', base64ToBytes(payload.image), payload.image_format)
        .then((hash) => channel.deliver({ type: 'ack', hash }));
    }
  };
}

// ── hello / status ───────────────────────────────────────────────────────

describe('ClipboardSync hello and status', () => {
  it('does not send hello before the agent reports status (old agents treat it as a clipboard write)', () => {
    const { channel } = setup({ status: null });
    expect(channel.sent).toEqual([]);
  });

  it('answers a chunk-capable status with exactly one hello', () => {
    const { channel } = setup();
    channel.deliver(W4A_STATUS);
    expect(channel.sentJson()).toEqual([{ type: 'hello', chunked: true }]);
  });

  it('sends no hello for a status that does not advertise chunking', () => {
    const { channel } = setup({ status: { ...W4A_STATUS, chunked: false } });
    expect(channel.sent).toEqual([]);
  });

  it('exposes the agent status, reading only real booleans', () => {
    const { sync } = setup({ status: { ...W4A_STATUS, viewerToHost: 'yes' } });
    expect(sync.state.status).toMatchObject({ hostToViewer: true, viewerToHost: false, chunked: true });
  });

  it('reports no status for a legacy agent', () => {
    const { sync } = setup({ status: null });
    expect(sync.state.status).toBeNull();
    expect(sync.state.open).toBe(true);
  });
});

// ── remote → local ───────────────────────────────────────────────────────

describe('ClipboardSync remote → local', () => {
  it('writes a remote text push to the focused window', async () => {
    const { channel, io, sync } = setup();
    channel.deliver({ type: 'text', text: 'hello' });
    await flush();
    expect(io.writeText).toHaveBeenCalledWith('hello');
    expect(sync.state.lastTransfer).toMatchObject({ direction: 'from-remote', type: 'text', bytes: 5 });
  });

  it('skips a legacy agent\'s connect-time baseline push but keeps it on offer', async () => {
    let now = 1_000;
    const { channel, io, sync } = setup({ status: null, now: () => now });
    channel.deliver({ type: 'text', text: 'end-user secret' });
    await flush();
    expect(io.writeText).not.toHaveBeenCalled();
    expect(sync.state.remoteItemAvailable).toBe(true);
    now += 100;
    channel.deliver({ type: 'text', text: 'real copy' });
    await flush();
    expect(io.writeText).toHaveBeenCalledWith('real copy');
  });

  it('does not skip the first push from an agent that suppresses the baseline', async () => {
    const { channel, io } = setup();
    channel.deliver({ type: 'text', text: 'first real copy' });
    await flush();
    expect(io.writeText).toHaveBeenCalledWith('first real copy');
  });

  it('counts an RTF push toward the baseline without writing it', async () => {
    let now = 1_000;
    const { channel, io } = setup({ status: null, now: () => now });
    channel.deliver({ type: 'rtf', rtf: bytesToBase64(new Uint8Array([1, 2])) });
    now += 50;
    channel.deliver({ type: 'text', text: 'after rtf' });
    await flush();
    expect(io.writeText).toHaveBeenCalledTimes(1);
    expect(io.writeText).toHaveBeenCalledWith('after rtf');
  });

  it('applies a first legacy push that arrives after the baseline window', async () => {
    let now = 1_000;
    const { channel, io } = setup({ status: null, now: () => now });
    now += REMOTE_CLIPBOARD_BASELINE_WINDOW_MS + 1;
    channel.deliver({ type: 'text', text: 'late' });
    await flush();
    expect(io.writeText).toHaveBeenCalledWith('late');
  });

  it('buffers a background push instead of writing it, and copyRemoteClipboard applies it', async () => {
    const { channel, io, sync } = setup({ focused: false });
    channel.deliver({ type: 'text', text: 'customer A data' });
    await flush();
    expect(io.writeText).not.toHaveBeenCalled();
    expect(sync.state.remoteItemAvailable).toBe(true);
    expect(await sync.copyRemoteClipboard()).toBe(true);
    expect(io.writeText).toHaveBeenCalledWith('customer A data');
    expect(sync.state.lastTransfer).toMatchObject({ direction: 'from-remote', bytes: 15 });
  });

  it('copyRemoteClipboard reports false when nothing has arrived', async () => {
    const { sync } = setup();
    expect(await sync.copyRemoteClipboard()).toBe(false);
  });

  it('writes a remote PNG image', async () => {
    const { channel, io, sync } = setup();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    channel.deliver({ type: 'image', image: bytesToBase64(png), image_format: 'png' });
    await flush();
    expect(io.writeImage).toHaveBeenCalledWith(png, 'png');
    expect(sync.state.lastTransfer).toMatchObject({ direction: 'from-remote', type: 'image', bytes: 7 });
  });

  it('ignores an image in an unknown format', async () => {
    const { channel, io } = setup();
    channel.deliver({ type: 'image', image: bytesToBase64(new Uint8Array([1])), image_format: 'bmp' });
    await flush();
    expect(io.writeImage).not.toHaveBeenCalled();
  });

  it('reassembles a chunked push, with acks interleaved between frames', async () => {
    const { channel, io } = setup();
    const text = 'x'.repeat(200_000);
    const frames = encodeChunks('t1', new TextEncoder().encode(JSON.stringify({ type: 'text', text })));
    expect(frames.length).toBeGreaterThan(2);
    for (const f of frames) {
      channel.dispatchEvent(new MessageEvent('message', { data: f }));
      channel.deliver({ type: 'ack', hash: 'deadbeef' });
    }
    await flush();
    expect(io.writeText).toHaveBeenCalledWith(text);
  });

  it('survives a broken chunk stream and applies the next transfer', async () => {
    const { channel, io } = setup();
    channel.deliver({ type: 'chunk', id: 'a', seq: 1, total: 3, data: '' });
    channel.deliver('{not json');
    const frames = encodeChunks('b', new TextEncoder().encode(JSON.stringify({ type: 'text', text: 'ok' })));
    channel.dispatchEvent(new MessageEvent('message', { data: frames[0] }));
    await flush();
    expect(io.writeText).toHaveBeenCalledWith('ok');
  });

  it('ignores remote text over the agent\'s text cap', async () => {
    const { channel, io } = setup();
    channel.deliver({ type: 'text', text: 'y'.repeat(1024 * 1024 + 1) });
    await flush();
    expect(io.writeText).not.toHaveBeenCalled();
  });
});

// ── paste transaction (agent sent status) ────────────────────────────────

describe('ClipboardSync paste transaction', () => {
  it('pushes the local text, waits for the ack, then dispatches', async () => {
    const { channel, sync } = setup({ local: { text: 'paste me' } });
    autoAck(channel);
    const order: string[] = [];
    const origSend = channel.sendImpl!;
    channel.sendImpl = (s) => { order.push(JSON.parse(s).type); origSend(s); };
    const out = await sync.pasteTransaction(() => order.push('dispatch'));
    expect(out).toEqual({ result: 'pasted' });
    expect(order).toEqual(['text', 'dispatch']);
    expect(sync.state.lastTransfer).toMatchObject({ direction: 'to-remote', type: 'text', bytes: 8 });
  });

  it('does not re-send content the remote already has', async () => {
    const { channel, sync } = setup({ local: { text: 'same' } });
    autoAck(channel);
    const dispatch = vi.fn();
    await sync.pasteTransaction(dispatch);
    const sends = channel.sent.length;
    await sync.pasteTransaction(dispatch);
    expect(channel.sent.length).toBe(sends);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('cancels the keystroke when no ack arrives, and retries the push next time', async () => {
    const { channel, sync } = setup({ local: { text: 'lost' } });
    const dispatch = vi.fn();
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'failed', reason: 'no-ack' });
    expect(dispatch).not.toHaveBeenCalled();
    const sends = channel.sent.length;
    await sync.pasteTransaction(dispatch);
    expect(channel.sent.length).toBe(sends + 1);
  });

  it('cancels the keystroke when the channel closes while waiting for the ack', async () => {
    const { channel, sync } = setup({ local: { text: 'mid-flight' } });
    const dispatch = vi.fn();
    const p = sync.pasteTransaction(dispatch);
    await sleep(5);
    channel.closeNow();
    expect(await p).toEqual({ result: 'failed', reason: 'closed' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(sync.state.open).toBe(false);
  });

  it('never dispatches once the controller is closed, even if the ack then arrives', async () => {
    const { channel, sync } = setup({ local: { text: 'stale session' } });
    const dispatch = vi.fn();
    const p = sync.pasteTransaction(dispatch);
    await sleep(5);
    sync.close();
    channel.deliver({ type: 'ack', hash: await agentHash('text', 'stale session') });
    expect((await p).result).toBe('failed');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('cancels the keystroke when the send throws', async () => {
    const { channel, sync } = setup({ local: { text: 'boom' } });
    channel.sendImpl = () => { throw new Error('closing'); };
    const dispatch = vi.fn();
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'failed', reason: 'send-failed' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('pastes the remote\'s own clipboard when viewer→host is disabled by policy', async () => {
    const { channel, sync, io } = setup({ local: { text: 'secret' }, status: { ...W4A_STATUS, viewerToHost: false } });
    const dispatch = vi.fn();
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'pasted' });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(io.readText).not.toHaveBeenCalled();
    expect(channel.sentJson().filter((m) => m.type !== 'hello')).toEqual([]);
  });

  it('always re-sends when host→viewer is off (the viewer cannot see the remote clipboard change)', async () => {
    const { channel, sync } = setup({ local: { text: 'same' }, status: { ...W4A_STATUS, hostToViewer: false } });
    autoAck(channel);
    await sync.pasteTransaction(() => {});
    const sends = channel.sent.length;
    await sync.pasteTransaction(() => {});
    expect(channel.sent.length).toBe(sends + 1);
  });

  it('refuses text over the agent\'s cap without sending or pasting', async () => {
    const { channel, sync } = setup({ local: { text: 'z'.repeat(11) }, status: { ...W4A_STATUS, maxTextBytes: 10 } });
    const dispatch = vi.fn();
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'failed', reason: 'too-large' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(channel.sentJson().filter((m) => m.type !== 'hello')).toEqual([]);
  });

  it('sends large text as chunk frames, each within the frame cap', async () => {
    const text = 'large '.repeat(100_000);
    const { channel, sync } = setup({ local: { text } });
    autoAck(channel);
    expect(await sync.pasteTransaction(() => {})).toEqual({ result: 'pasted' });
    const frames = channel.sent.filter((s) => JSON.parse(s).type === 'chunk');
    expect(frames.length).toBeGreaterThan(10);
    for (const f of frames) expect(f.length).toBeLessThanOrEqual(CHUNK_FRAME_MAX_BYTES);
  });

  it('pushes a local image as PNG when the clipboard holds no text', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]);
    const { channel, sync } = setup({ local: { text: '', image: png } });
    autoAck(channel);
    expect(await sync.pasteTransaction(() => {})).toEqual({ result: 'pasted' });
    const msg = channel.sentJson().find((m) => m.type === 'image')!;
    expect(msg).toEqual({ type: 'image', image: bytesToBase64(png), image_format: 'png' });
    expect(sync.state.lastTransfer).toMatchObject({ direction: 'to-remote', type: 'image', bytes: 6 });
  });

  it('refuses the paste, with a reason, when the local clipboard is empty or unreadable (#11310 row 1)', async () => {
    // A file on the Mac clipboard reads as nothing. Dispatching anyway would
    // silently paste the remote's older clipboard instead of what the
    // operator just copied.
    const { channel, sync, io } = setup({ local: { text: null, image: null } });
    io.readText.mockRejectedValueOnce(new Error('denied'));
    const dispatch = vi.fn();
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'failed', reason: 'unreadable' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(channel.sentJson().filter((m) => m.type !== 'hello')).toEqual([]);
  });

  it('refuses an unreadable-clipboard paste for a legacy agent too (viewer-side rule)', async () => {
    const { sync } = setup({ local: { text: null, image: null }, status: null });
    const dispatch = vi.fn();
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'failed', reason: 'unreadable' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('serializes pastes: the second push waits for the first keystroke', async () => {
    const { channel, sync, io } = setup({ local: { text: 'one' } });
    autoAck(channel);
    const order: string[] = [];
    const origSend = channel.sendImpl!;
    channel.sendImpl = (s) => { const m = JSON.parse(s); order.push(`send:${m.text}`); origSend(s); };
    io.readText.mockResolvedValueOnce('one').mockResolvedValueOnce('two');
    const a = sync.pasteTransaction(() => order.push('dispatch:one'));
    const b = sync.pasteTransaction(() => order.push('dispatch:two'));
    await Promise.all([a, b]);
    expect(order).toEqual(['send:one', 'dispatch:one', 'send:two', 'dispatch:two']);
  });

  it('does not dispatch a paste queued behind one the channel close cancelled', async () => {
    const { channel, sync } = setup({ local: { text: 'queued' } });
    const first = vi.fn();
    const second = vi.fn();
    const a = sync.pasteTransaction(first);
    const b = sync.pasteTransaction(second);
    await sleep(5);
    channel.closeNow();
    expect(await a).toEqual({ result: 'failed', reason: 'closed' });
    expect(await b).toEqual({ result: 'failed', reason: 'closed' });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('does not re-upload a remote image it wrote locally (the local copy is re-encoded)', async () => {
    const { channel, sync, io } = setup();
    const remotePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]);
    const reencoded = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2, 2]);
    io.image = reencoded;
    io.text = '';
    channel.deliver({ type: 'image', image: bytesToBase64(remotePng), image_format: 'png' });
    await flush();
    expect(io.writeImage).toHaveBeenCalled();
    const sends = channel.sent.length;
    const dispatch = vi.fn();
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'pasted' });
    expect(channel.sent.length).toBe(sends);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('cancels a paste on a closing channel once the agent was known to ack', async () => {
    const { channel, sync } = setup({ local: { text: 'x' } });
    channel.readyState = 'closing';
    const dispatch = vi.fn();
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'failed', reason: 'closed' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches immediately on a channel that is not open for a legacy agent (W1)', async () => {
    const { channel, sync } = setup({ local: { text: 'x' }, status: null });
    channel.readyState = 'closing';
    const dispatch = vi.fn();
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'pasted' });
    expect(dispatch).toHaveBeenCalledOnce();
  });
});

// ── #11310: input-recency policy, held items, change order ───────────────

describe('ClipboardSync input-recency policy (#11310)', () => {
  it('holds a remote push to the focused window when the operator has not used the session (row 2)', async () => {
    const { channel, io, sync } = setup({ inputAt: null });
    channel.deliver({ type: 'text', text: 'changed by itself' });
    await flush();
    expect(io.writeText).not.toHaveBeenCalled();
    expect(sync.state.remoteHeld).toBe('item');
    expect(sync.state.remoteItemAvailable).toBe(true);
  });

  it('applies a remote push within 2 s of the operator\'s input', async () => {
    let now = 50_000;
    const { channel, io, sync } = setup({ inputAt: 48_500, now: () => now });
    channel.deliver({ type: 'text', text: 'after a click' });
    await flush();
    expect(io.writeText).toHaveBeenCalledWith('after a click');
    expect(sync.state.remoteHeld).toBeNull();
    now += 2_000;
    channel.deliver({ type: 'text', text: 'too late' });
    await flush();
    expect(io.writeText).toHaveBeenCalledTimes(1);
    expect(sync.state.remoteHeld).toBe('item');
  });

  it('pulling a held item applies it and clears the badge', async () => {
    const { channel, io, sync } = setup({ inputAt: null });
    channel.deliver({ type: 'text', text: 'held' });
    await flush();
    expect(await sync.copyRemoteClipboard()).toBe(true);
    expect(io.writeText).toHaveBeenCalledWith('held');
    expect(sync.state.remoteHeld).toBeNull();
  });

  it('does not flag a legacy agent\'s skipped baseline as a held change', async () => {
    const now = 1_000;
    const { channel, sync } = setup({ status: null, now: () => now, inputAt: null });
    channel.deliver({ type: 'text', text: 'end-user clipboard' });
    await flush();
    expect(sync.state.remoteHeld).toBeNull();
    expect(sync.state.remoteItemAvailable).toBe(true);
  });
});

describe('ClipboardSync change order (#11310)', () => {
  it('pastes the remote\'s own clipboard when it changed after the local one (held item, local unchanged)', async () => {
    const { channel, sync, io } = setup({ local: { text: 'older local' }, inputAt: null });
    autoAck(channel);
    channel.deliver({ type: 'text', text: 'newer remote' });
    await flush();
    const before = channel.sent.length;
    const dispatch = vi.fn();
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'pasted' });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(channel.sent.length).toBe(before);
    expect(io.writeText).not.toHaveBeenCalled();
    expect(sync.state.remoteHeld).toBe('item');
  });

  it('pushes the local clipboard when it changed after the held remote change', async () => {
    const { channel, sync, io } = setup({ local: { text: 'older local' }, inputAt: null });
    autoAck(channel);
    channel.deliver({ type: 'text', text: 'remote' });
    await flush();
    io.text = 'copied on the Mac afterwards';
    const dispatch = vi.fn();
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'pasted' });
    expect(channel.sentJson().filter((m) => m.type === 'text')).toEqual([{ type: 'text', text: 'copied on the Mac afterwards' }]);
    expect(sync.state.remoteHeld).toBeNull();
  });

  it('treats a remote format the viewer cannot hold (RTF) as a newer remote change', async () => {
    const { channel, sync } = setup({ local: { text: 'local' } });
    channel.deliver({ type: 'rtf', rtf: bytesToBase64(new Uint8Array([1, 2, 3])) });
    await flush();
    expect(sync.state.remoteHeld).toBe('unsupported');
    expect(sync.state.remoteItemAvailable).toBe(false);
    const dispatch = vi.fn();
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'pasted' });
    expect(channel.sentJson().filter((m) => m.type === 'text')).toEqual([]);
  });

  it('does not paste over a remote re-copy made after the last push (row 3)', async () => {
    // The Mac pastes Y (pushed); the remote then copies X again, which a
    // changeNotices agent reports even when X is what it last sent. Cmd+V
    // with the Mac clipboard still Y must paste X, not push Y over it.
    const { channel, sync } = setup({ local: { text: 'Y' }, status: NOTICES_STATUS, inputAt: null });
    autoAck(channel);
    await sync.pasteTransaction(() => {});
    channel.deliver({ type: 'text', text: 'X' });
    await flush();
    // Local still Y, unchanged since the remote's X: the remote is newer.
    const dispatch = vi.fn();
    const before = channel.sent.length;
    await sync.pasteTransaction(dispatch);
    expect(channel.sent.length).toBe(before);
    expect(dispatch).toHaveBeenCalledOnce();
  });
});

describe('ClipboardSync change notices (#11310 rows 5–6)', () => {
  it('asks for change notices in its hello only when the agent offers them', () => {
    const { channel } = setup({ status: NOTICES_STATUS });
    expect(channel.sentJson()).toEqual([{ type: 'hello', chunked: true, changeNotices: true }]);
    expect(setup().channel.sentJson()).toEqual([{ type: 'hello', chunked: true }]);
  });

  it('a remote file copy is held as unsupported, and an unchanged local clipboard is not pushed over it', async () => {
    const { channel, sync } = setup({ local: { text: 'Mac text' }, status: NOTICES_STATUS });
    autoAck(channel);
    channel.deliver({ type: 'text', text: 'earlier remote' });
    await flush();
    channel.deliver({ type: 'unsupported', seq: 4 });
    await flush();
    expect(sync.state.remoteHeld).toBe('unsupported');
    expect(sync.state.remoteItemAvailable).toBe(false);
    expect(await sync.copyRemoteClipboard()).toBe(false);
    const dispatch = vi.fn();
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'pasted' });
    expect(channel.sentJson().filter((m) => m.type === 'text')).toEqual([]);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('pushes once the local clipboard changes after the unsupported remote change', async () => {
    const { channel, sync, io } = setup({ local: { text: 'Mac text' }, status: NOTICES_STATUS });
    autoAck(channel);
    channel.deliver({ type: 'unsupported', seq: 1 });
    await flush();
    io.text = 'new Mac text';
    await sync.pasteTransaction(() => {});
    expect(channel.sentJson().filter((m) => m.type === 'text')).toEqual([{ type: 'text', text: 'new Mac text' }]);
    expect(sync.state.remoteHeld).toBeNull();
  });

  it('an empty remote clipboard makes the next paste push, even content synced before', async () => {
    const { channel, sync } = setup({ local: { text: 'same' }, status: NOTICES_STATUS });
    autoAck(channel);
    await sync.pasteTransaction(() => {});
    const before = channel.sent.length;
    channel.deliver({ type: 'unsupported', seq: 2, empty: true });
    await flush();
    expect(sync.state.remoteHeld).toBeNull();
    await sync.pasteTransaction(() => {});
    expect(channel.sent.length).toBe(before + 1);
  });

  it('ignores a change notice from an agent that did not offer them', async () => {
    const { channel, sync } = setup({ local: { text: 'Mac' } });
    autoAck(channel);
    channel.deliver({ type: 'unsupported', seq: 1 });
    await flush();
    expect(sync.state.remoteHeld).toBeNull();
  });
});

describe('ClipboardSync copy chord then quick paste (#11310 row 4)', () => {
  it('with a changeNotices agent, waits briefly for the copy to arrive instead of pushing the older local clipboard', async () => {
    const { channel, sync, io } = setup({ local: { text: 'older Mac clipboard' }, status: NOTICES_STATUS, copyIntentAt: Date.now() });
    autoAck(channel);
    setTimeout(() => channel.deliver({ type: 'text', text: 'fresh remote copy' }), 40);
    io.writeText.mockImplementation(async (t: string) => { io.text = t; });
    const dispatch = vi.fn();
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'pasted' });
    expect(io.writeText).toHaveBeenCalledWith('fresh remote copy');
    expect(channel.sentJson().filter((m) => m.type === 'text')).toEqual([]);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('gives up waiting after the settle window when the copy changed nothing', async () => {
    const { channel, sync } = setup({ local: { text: 'Mac' }, status: NOTICES_STATUS, copyIntentAt: Date.now(), copySettleMs: 50 });
    autoAck(channel);
    const started = Date.now();
    expect(await sync.pasteTransaction(() => {})).toEqual({ result: 'pasted' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('does not wait for an agent without change notices (today\'s behaviour)', async () => {
    const { channel, sync } = setup({ local: { text: 'Mac' }, copyIntentAt: Date.now(), copySettleMs: 500 });
    autoAck(channel);
    const started = Date.now();
    await sync.pasteTransaction(() => {});
    expect(Date.now() - started).toBeLessThan(150);
  });
});

// ── backpressure ─────────────────────────────────────────────────────────

describe('ClipboardSync chunked send backpressure', () => {
  const big = 'b'.repeat(300_000);

  it('holds frames while the channel buffer is over the high-water mark', async () => {
    const { channel, sync } = setup({ local: { text: big } });
    autoAck(channel);
    channel.bufferedAmount = CLIPBOARD_BUFFER_HIGH_WATER + 1;
    const p = sync.pasteTransaction(() => {});
    await sleep(20);
    expect(channel.sent.filter((s) => s.includes('"chunk"'))).toEqual([]);
    channel.bufferedAmount = 0;
    expect(await p).toEqual({ result: 'pasted' });
  });

  it('gives up when the buffer never drains', async () => {
    const { channel, sync } = setup({ local: { text: big } });
    channel.bufferedAmount = CLIPBOARD_BUFFER_HIGH_WATER + 1;
    const dispatch = vi.fn();
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'failed', reason: 'send-failed' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('stops waiting when the channel closes', async () => {
    const { channel, sync } = setup({ local: { text: big } });
    channel.bufferedAmount = CLIPBOARD_BUFFER_HIGH_WATER + 1;
    const p = sync.pasteTransaction(() => {});
    await sleep(5);
    channel.closeNow();
    expect(await p).toEqual({ result: 'failed', reason: 'closed' });
  });
});

// ── legacy agent (never sends status) — the W1 behaviour ─────────────────

describe('ClipboardSync legacy agent', () => {
  it('sends the clipboard text BEFORE dispatching the paste', async () => {
    const { channel, sync } = setup({ local: { text: 'hello world' }, status: null });
    const order: string[] = [];
    channel.sendImpl = () => order.push('send');
    await sync.pasteTransaction(() => order.push('dispatch'));
    expect(order).toEqual(['send', 'dispatch']);
    expect(channel.sentJson()).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('still dispatches when no ack arrives (agents that predate the ack exist)', async () => {
    const { sync } = setup({ local: { text: 'no ack' }, status: null });
    const dispatch = vi.fn();
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'pasted' });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('dispatches as soon as the ack arrives', async () => {
    const { channel, sync } = setup({ local: { text: 'quick' }, status: null });
    autoAck(channel);
    const started = Date.now();
    await sync.pasteTransaction(() => {});
    expect(Date.now() - started).toBeLessThan(25);
  });

  it('skips the push for text it already synced but still dispatches', async () => {
    const { channel, sync } = setup({ local: { text: 'same' }, status: null });
    await sync.pasteTransaction(() => {});
    const dispatch = vi.fn();
    await sync.pasteTransaction(dispatch);
    expect(channel.sent).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('skips the push for text the remote just sent', async () => {
    let now = 1_000;
    const { channel, sync } = setup({ local: { text: 'from remote' }, status: null, now: () => now });
    now += REMOTE_CLIPBOARD_BASELINE_WINDOW_MS + 1;
    channel.deliver({ type: 'text', text: 'from remote' });
    await flush();
    await sync.pasteTransaction(() => {});
    expect(channel.sent).toEqual([]);
  });

  it('does NOT dispatch when the send throws, and does not cache the content', async () => {
    const { channel, sync } = setup({ local: { text: 'big' }, status: null });
    channel.sendImpl = () => { throw new Error('message too large'); };
    const dispatch = vi.fn();
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'failed', reason: 'send-failed' });
    expect(dispatch).not.toHaveBeenCalled();
    channel.sendImpl = null;
    await sync.pasteTransaction(dispatch);
    expect(channel.sent).toHaveLength(1);
  });

  it('never chunks: content over the old agent\'s message cap is refused', async () => {
    const { channel, sync } = setup({ local: { text: '', image: new Uint8Array(LEGACY_MAX_MESSAGE_BYTES) }, status: null });
    const dispatch = vi.fn();
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'failed', reason: 'too-large' });
    expect(channel.sent).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('still dispatches when the channel closes after the push', async () => {
    const { channel, sync } = setup({ local: { text: 'then closed' }, status: null });
    const dispatch = vi.fn();
    channel.sendImpl = () => setTimeout(() => channel.closeNow(), 1);
    expect(await sync.pasteTransaction(dispatch)).toEqual({ result: 'pasted' });
    expect(dispatch).toHaveBeenCalledOnce();
  });
});

// ── toolbar actions ──────────────────────────────────────────────────────

describe('ClipboardSync.sendLocalClipboard', () => {
  it('sends the local clipboard without a keystroke and reports the size', async () => {
    const { channel, sync } = setup({ local: { text: 'to remote' } });
    autoAck(channel);
    expect(await sync.sendLocalClipboard()).toEqual({ result: 'sent', bytes: 9 });
  });

  it('sends even content it already synced (an explicit request)', async () => {
    const { channel, sync } = setup({ local: { text: 'again' } });
    autoAck(channel);
    await sync.sendLocalClipboard();
    const sends = channel.sent.length;
    await sync.sendLocalClipboard();
    expect(channel.sent.length).toBe(sends + 1);
  });

  it('reports disabled when viewer→host is off by policy', async () => {
    const { sync } = setup({ local: { text: 'x' }, status: { ...W4A_STATUS, viewerToHost: false } });
    expect(await sync.sendLocalClipboard()).toEqual({ result: 'failed', reason: 'disabled' });
  });

  it('reports empty for an empty clipboard', async () => {
    const { sync } = setup({ local: { text: '' } });
    expect(await sync.sendLocalClipboard()).toEqual({ result: 'empty' });
  });

  it('reports closed after the channel closed', async () => {
    const { channel, sync } = setup({ local: { text: 'x' } });
    channel.closeNow();
    expect(await sync.sendLocalClipboard()).toEqual({ result: 'failed', reason: 'closed' });
  });
});

describe('ClipboardSync state notifications', () => {
  it('notifies on status, transfers and close', async () => {
    const { channel, onChange } = setup();
    expect(onChange).toHaveBeenCalled();
    onChange.mockClear();
    channel.deliver({ type: 'text', text: 'n' });
    await flush();
    expect(onChange).toHaveBeenCalled();
    onChange.mockClear();
    channel.closeNow();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ open: false }));
  });
});
