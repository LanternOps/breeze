/**
 * Text clipboard for VNC sessions (spec gotcha C6), through noVNC's
 * `clipboard` event (server cut text) and `clipboardPasteFrom` (client cut text).
 *
 * The RFB stream reaches the remote's VNC server raw through the tunnel, so the
 * agent cannot enforce the remote_access clipboard policy here the way it does
 * on the WebRTC clipboard channel. The stock viewer must not become a bypass of
 * that policy: every direction is off unless the API reported the session's
 * clipboard policy alongside the tunnel, and a missing policy means off.
 *
 * Paste ordering: noVNC sends a key the moment it sees the keydown, which would
 * reach the server before the clipboard. A capture-phase listener on the
 * container holds the paste key back from noVNC's canvas, sends the local
 * clipboard, then sends the key itself. The modifiers were already sent by
 * noVNC when they went down; noVNC ignores the later keyup of a key it never
 * saw go down.
 */
import { isCopyChord, isPasteChord, remoteClipboardDecision } from './inputSafety';
import type { ClipboardDirectionPolicy } from './clipboardChip';
import { MAX_TEXT_BYTES, type ClipboardTransfer, type PushFailure } from './clipboardSync';

export interface VncRfbLike {
  addEventListener(type: 'clipboard', cb: (e: Event) => void): void;
  removeEventListener(type: 'clipboard', cb: (e: Event) => void): void;
  clipboardPasteFrom(text: string): void;
  sendKey(keysym: number, code: string | null, down?: boolean): void;
}

export interface VncClipboardDeps {
  /** From the API, alongside the tunnel. undefined/null keeps both directions off. */
  policy: ClipboardDirectionPolicy | null | undefined;
  readLocalText(): Promise<string | null>;
  writeLocalText(text: string): Promise<void>;
  hasFocus(): boolean;
  now?(): number;
  onChange?(state: VncClipboardState): void;
  /** A paste whose key was withheld, because sending it would paste stale content. */
  onPasteFailed?(reason: PushFailure): void;
}

export interface VncClipboardState {
  policy: ClipboardDirectionPolicy | null;
  lastTransfer: ClipboardTransfer | null;
  remoteItemAvailable: boolean;
}

export type VncSendOutcome =
  | { result: 'sent'; bytes: number }
  | { result: 'empty' }
  | { result: 'failed'; reason: PushFailure };

export interface VncClipboardHandle {
  readonly state: VncClipboardState;
  sendLocalClipboard(): Promise<VncSendOutcome>;
  copyRemoteClipboard(): Promise<boolean>;
  detach(): void;
}

/** Reads `{clipboard:{hostToViewer, viewerToHost}}` off an API response; anything else is no policy. */
export function parseClipboardPolicy(body: unknown): ClipboardDirectionPolicy | undefined {
  const c = (body as { clipboard?: unknown } | null)?.clipboard as Record<string, unknown> | undefined;
  if (!c || typeof c.hostToViewer !== 'boolean' || typeof c.viewerToHost !== 'boolean') return undefined;
  return { hostToViewer: c.hostToViewer, viewerToHost: c.viewerToHost };
}

const XK_INSERT = 0xff63;

/** The X keysym for the paste key itself (V or Insert). Latin-1 keysyms are their code points. */
function pasteKeysym(e: KeyboardEvent): number {
  if (e.code === 'Insert') return XK_INSERT;
  if (e.key && e.key.length === 1) {
    const cp = e.key.codePointAt(0)!;
    if (cp < 0x100) return cp;
  }
  return e.shiftKey ? 0x56 : 0x76; // 'V' / 'v'
}

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

export function attachVncClipboard(
  rfb: VncRfbLike,
  keyTarget: EventTarget,
  deps: VncClipboardDeps,
): VncClipboardHandle {
  const now = deps.now ?? Date.now;
  const policy = deps.policy ?? null;
  const openedAt = now();
  let pushesSeen = 0;
  let lastCopyIntentAt: number | null = null;
  let remoteText: string | null = null;
  let lastTransfer: ClipboardTransfer | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let detached = false;

  const state = (): VncClipboardState => ({ policy, lastTransfer, remoteItemAvailable: remoteText !== null });
  const emit = () => deps.onChange?.(state());
  const record = (direction: ClipboardTransfer['direction'], text: string) => {
    lastTransfer = { direction, type: 'text', bytes: utf8Length(text), at: now() };
    emit();
  };

  async function writeLocal(text: string): Promise<boolean> {
    try {
      await deps.writeLocalText(text);
    } catch (err) {
      console.warn('[vnc-clipboard] failed to write remote→local:', err);
      return false;
    }
    record('from-remote', text);
    return true;
  }

  async function readLocal(): Promise<string | 'too-large' | null> {
    let text: string | null;
    try {
      text = await deps.readLocalText();
    } catch (err) {
      console.warn('[vnc-clipboard] local read failed:', err);
      return null;
    }
    if (!text) return null;
    return utf8Length(text) <= MAX_TEXT_BYTES ? text : 'too-large';
  }

  const onServerCut = (e: Event) => {
    if (detached || !policy?.hostToViewer) return;
    const text = (e as CustomEvent<{ text?: unknown }>).detail?.text;
    const seen = pushesSeen++;
    if (typeof text !== 'string' || text === '' || utf8Length(text) > MAX_TEXT_BYTES) return;
    remoteText = text;
    const decision = remoteClipboardDecision({
      now: now(),
      hasFocus: deps.hasFocus(),
      lastCopyIntentAt,
      channelOpenedAt: openedAt,
      pushesSeen: seen,
    });
    if (decision === 'apply') void writeLocal(text);
    else emit();
  };

  const onKeyDown = (e: Event) => {
    const ke = e as KeyboardEvent;
    if (detached || !policy) return;
    if (isCopyChord(ke)) lastCopyIntentAt = now();
    if (!policy.viewerToHost || !isPasteChord(ke)) return;
    // Hold the key back from noVNC until the clipboard has gone out.
    ke.preventDefault();
    ke.stopPropagation();
    const keysym = pasteKeysym(ke);
    const code = ke.code;
    queue = queue.then(async () => {
      const text = await readLocal();
      if (detached) return;
      if (text === 'too-large') {
        deps.onPasteFailed?.('too-large');
        return;
      }
      if (text) {
        rfb.clipboardPasteFrom(text);
        record('to-remote', text);
      }
      rfb.sendKey(keysym, code);
    }).catch((err) => console.warn('[vnc-clipboard] paste failed:', err));
  };

  rfb.addEventListener('clipboard', onServerCut);
  keyTarget.addEventListener('keydown', onKeyDown, true);

  return {
    get state() { return state(); },
    async sendLocalClipboard() {
      if (detached) return { result: 'failed', reason: 'closed' };
      if (!policy?.viewerToHost) return { result: 'failed', reason: 'disabled' };
      const text = await readLocal();
      if (text === 'too-large') return { result: 'failed', reason: 'too-large' };
      if (!text) return { result: 'empty' };
      rfb.clipboardPasteFrom(text);
      record('to-remote', text);
      return { result: 'sent', bytes: utf8Length(text) };
    },
    async copyRemoteClipboard() {
      if (!policy?.hostToViewer || remoteText === null) return false;
      return writeLocal(remoteText);
    },
    detach() {
      detached = true;
      rfb.removeEventListener('clipboard', onServerCut);
      keyTarget.removeEventListener('keydown', onKeyDown, true);
    },
  };
}
