import { describe, it, expect, vi } from 'vitest';
import { attachVncClipboard, parseClipboardPolicy, type VncRfbLike } from './vncClipboard';
import { REMOTE_CLIPBOARD_BASELINE_WINDOW_MS } from './inputSafety';

class FakeRfb extends EventTarget implements VncRfbLike {
  calls: string[] = [];
  clipboardPasteFrom = vi.fn((text: string) => { this.calls.push(`clip:${text}`); });
  sendKey = vi.fn((keysym: number, code: string | null, down?: boolean) => {
    this.calls.push(`key:${keysym.toString(16)}:${code}:${down === undefined ? 'press' : down}`);
  });
  serverCut(text: string) {
    this.dispatchEvent(new CustomEvent('clipboard', { detail: { text } }));
  }
}

const ON = { hostToViewer: true, viewerToHost: true };
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

function setup(opts: { policy?: typeof ON | null; local?: string | null; focused?: boolean } = {}) {
  let now = 1_000;
  const rfb = new FakeRfb();
  const container = document.createElement('div');
  const canvas = document.createElement('canvas');
  container.appendChild(canvas);
  document.body.appendChild(container);
  const novncSaw = vi.fn();
  canvas.addEventListener('keydown', novncSaw);
  const deps = {
    policy: opts.policy === undefined ? ON : opts.policy,
    readLocalText: vi.fn(async () => (opts.local === undefined ? 'local text' : opts.local)),
    writeLocalText: vi.fn(async (_t: string) => {}),
    hasFocus: () => opts.focused ?? true,
    now: () => now,
    onChange: vi.fn(),
  };
  const handle = attachVncClipboard(rfb, container, deps);
  const press = (init: KeyboardEventInit) => {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    canvas.dispatchEvent(ev);
    return ev;
  };
  return { rfb, container, canvas, deps, handle, press, novncSaw, advance: (ms: number) => { now += ms; } };
}

describe('attachVncClipboard remote → local', () => {
  it('writes a server cut to the focused window after the baseline window', async () => {
    const { rfb, deps, handle, advance } = setup();
    advance(REMOTE_CLIPBOARD_BASELINE_WINDOW_MS + 1);
    rfb.serverCut('from mac');
    await flush();
    expect(deps.writeLocalText).toHaveBeenCalledWith('from mac');
    expect(handle.state.lastTransfer).toMatchObject({ direction: 'from-remote', bytes: 8 });
  });

  it('skips the connect-time baseline but keeps it on offer', async () => {
    const { rfb, deps, handle } = setup();
    rfb.serverCut('end user clipboard');
    await flush();
    expect(deps.writeLocalText).not.toHaveBeenCalled();
    expect(handle.state.remoteItemAvailable).toBe(true);
    expect(await handle.copyRemoteClipboard()).toBe(true);
    expect(deps.writeLocalText).toHaveBeenCalledWith('end user clipboard');
  });

  it('buffers a background window\'s server cut instead of writing it', async () => {
    const { rfb, deps, handle, advance } = setup({ focused: false });
    advance(REMOTE_CLIPBOARD_BASELINE_WINDOW_MS + 1);
    rfb.serverCut('customer A');
    await flush();
    expect(deps.writeLocalText).not.toHaveBeenCalled();
    expect(handle.state.remoteItemAvailable).toBe(true);
  });

  it('ignores server cuts entirely when host→viewer is off or no policy was reported', async () => {
    for (const policy of [{ hostToViewer: false, viewerToHost: true }, null]) {
      const { rfb, deps, handle, advance } = setup({ policy });
      advance(REMOTE_CLIPBOARD_BASELINE_WINDOW_MS + 1);
      rfb.serverCut('secret');
      await flush();
      expect(deps.writeLocalText).not.toHaveBeenCalled();
      expect(handle.state.remoteItemAvailable).toBe(false);
      expect(await handle.copyRemoteClipboard()).toBe(false);
    }
  });
});

describe('attachVncClipboard paste', () => {
  it('holds the paste key from noVNC, pushes the clipboard, then sends the key', async () => {
    const { rfb, press, novncSaw, handle } = setup();
    const ev = press({ code: 'KeyV', key: 'v', ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(novncSaw).not.toHaveBeenCalled();
    await flush();
    expect(rfb.calls).toEqual(['clip:local text', 'key:76:KeyV:press']);
    expect(handle.state.lastTransfer).toMatchObject({ direction: 'to-remote', bytes: 10 });
  });

  it('sends Shift+Insert as Insert', async () => {
    const { rfb, press } = setup();
    press({ code: 'Insert', key: 'Insert', shiftKey: true });
    await flush();
    expect(rfb.calls).toEqual(['clip:local text', 'key:ff63:Insert:press']);
  });

  it('sends the key with no push when the local clipboard is empty', async () => {
    const { rfb, press } = setup({ local: '' });
    press({ code: 'KeyV', key: 'v', metaKey: true });
    await flush();
    expect(rfb.calls).toEqual(['key:76:KeyV:press']);
  });

  it('leaves the paste to noVNC when viewer→host is off, or no policy was reported', async () => {
    for (const policy of [{ hostToViewer: true, viewerToHost: false }, null]) {
      const { rfb, press, novncSaw, deps } = setup({ policy });
      const ev = press({ code: 'KeyV', key: 'v', ctrlKey: true });
      await flush();
      expect(ev.defaultPrevented).toBe(false);
      expect(novncSaw).toHaveBeenCalledOnce();
      expect(deps.readLocalText).not.toHaveBeenCalled();
      expect(rfb.calls).toEqual([]);
    }
  });

  it('lets ordinary keys through to noVNC', () => {
    const { press, novncSaw } = setup();
    press({ code: 'KeyA', key: 'a' });
    expect(novncSaw).toHaveBeenCalledOnce();
  });

  it('serializes pastes so keys stay in order', async () => {
    const { rfb, press, deps } = setup();
    deps.readLocalText.mockResolvedValueOnce('one').mockResolvedValueOnce('two');
    press({ code: 'KeyV', key: 'v', ctrlKey: true });
    press({ code: 'KeyV', key: 'v', ctrlKey: true });
    await flush();
    expect(rfb.calls).toEqual(['clip:one', 'key:76:KeyV:press', 'clip:two', 'key:76:KeyV:press']);
  });

  it('still sends the key when the local clipboard cannot be read', async () => {
    const { rfb, press, deps } = setup();
    deps.readLocalText.mockRejectedValueOnce(new Error('denied'));
    press({ code: 'KeyV', key: 'v', ctrlKey: true });
    await flush();
    expect(rfb.calls).toEqual(['key:76:KeyV:press']);
  });

  it('withholds the key when the local text is over the cap', async () => {
    const { rfb, press, deps } = setup({ local: 'x'.repeat(1024 * 1024 + 1) });
    const onPasteFailed = vi.fn();
    (deps as { onPasteFailed?: unknown }).onPasteFailed = onPasteFailed;
    press({ code: 'KeyV', key: 'v', ctrlKey: true });
    await flush();
    expect(rfb.calls).toEqual([]);
    expect(onPasteFailed).toHaveBeenCalledWith('too-large');
  });

  it('records copy intent so a copy-then-Alt-Tab result still lands', async () => {
    const { rfb, press, deps, advance } = setup({ focused: false });
    advance(REMOTE_CLIPBOARD_BASELINE_WINDOW_MS + 1);
    press({ code: 'KeyC', key: 'c', metaKey: true });
    rfb.serverCut('copied');
    await flush();
    expect(deps.writeLocalText).toHaveBeenCalledWith('copied');
  });

  it('detach removes both listeners', async () => {
    const { rfb, press, novncSaw, handle, deps, advance } = setup();
    handle.detach();
    advance(REMOTE_CLIPBOARD_BASELINE_WINDOW_MS + 1);
    press({ code: 'KeyV', key: 'v', ctrlKey: true });
    rfb.serverCut('after detach');
    await flush();
    expect(novncSaw).toHaveBeenCalledOnce();
    expect(deps.writeLocalText).not.toHaveBeenCalled();
  });
});

describe('attachVncClipboard.sendLocalClipboard', () => {
  it('pushes text with no key', async () => {
    const { rfb, handle } = setup();
    expect(await handle.sendLocalClipboard()).toEqual({ result: 'sent', bytes: 10 });
    expect(rfb.calls).toEqual(['clip:local text']);
  });

  it('refuses when viewer→host is off', async () => {
    const { handle } = setup({ policy: { hostToViewer: true, viewerToHost: false } });
    expect(await handle.sendLocalClipboard()).toEqual({ result: 'failed', reason: 'disabled' });
  });

  it('reports an empty clipboard', async () => {
    const { handle } = setup({ local: null });
    expect(await handle.sendLocalClipboard()).toEqual({ result: 'empty' });
  });
});

describe('parseClipboardPolicy', () => {
  it('accepts only a strict boolean pair', () => {
    expect(parseClipboardPolicy({ clipboard: { hostToViewer: true, viewerToHost: false } }))
      .toEqual({ hostToViewer: true, viewerToHost: false });
    expect(parseClipboardPolicy({})).toBeUndefined();
    expect(parseClipboardPolicy({ clipboard: { hostToViewer: 'true', viewerToHost: true } })).toBeUndefined();
    expect(parseClipboardPolicy(null)).toBeUndefined();
  });
});
