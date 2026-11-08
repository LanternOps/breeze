/**
 * Pure decisions behind the viewer's input and clipboard safety rules.
 *
 * Each one exists because getting it wrong leaves something stuck or misrouted
 * on the customer's machine. See
 * docs/superpowers/specs/remote-desktop/2026-10-07-viewer-input-clipboard-convenience-design.md
 * (gotchas K5, K6, K7, M1, C1).
 */

export type ViewerOs = 'windows' | 'macos' | 'linux' | 'unknown';

export function detectViewerOs(userAgent: string): ViewerOs {
  if (/Mac OS X|Macintosh/.test(userAgent)) return 'macos';
  if (/Windows/.test(userAgent)) return 'windows';
  if (/Linux|X11/.test(userAgent)) return 'linux';
  return 'unknown';
}

/**
 * Whether Cmd↔Ctrl swapping should start on for this viewer/remote pair.
 *
 * Only a Mac on exactly one side of the session needs it. Turning it on for a
 * Windows viewer driving a Windows remote sends a held Ctrl as `meta`, which
 * the Windows agent injects as the Win key (K6). While the remote OS is still
 * unknown, assume a non-Mac remote: that is the common case.
 */
export function defaultRemapCmdCtrl(viewerOs: ViewerOs, remoteOs: string | null): boolean {
  if (viewerOs === 'unknown') return false;
  const viewerIsMac = viewerOs === 'macos';
  const remoteIsMac = remoteOs === 'macos';
  return viewerIsMac !== remoteIsMac;
}

export type AgentMouseButton = 'left' | 'middle' | 'right' | 'back' | 'forward';

/**
 * DOM MouseEvent.button → agent button name. Back (3) and forward (4) map only
 * when the agent advertised support for them (W2c); otherwise null drops them
 * instead of the old fallback, which sent them as a left click (M1).
 */
export function mouseButtonName(
  button: number,
  opts: { extraButtons?: boolean } = {},
): AgentMouseButton | null {
  switch (button) {
    case 0: return 'left';
    case 1: return 'middle';
    case 2: return 'right';
    case 3: return opts.extraButtons ? 'back' : null;
    case 4: return opts.extraButtons ? 'forward' : null;
    default: return null;
  }
}

/**
 * Whether OS autorepeat key-downs should be forwarded for a held key (K7).
 *
 * Windows and macOS do not autorepeat injected key-downs, so without forwarding
 * a held Backspace deletes one character. The X server does autorepeat keys
 * held through XTEST, so forwarding there would double the repeat rate.
 */
export function shouldForwardKeyRepeat(remoteOs: string | null): boolean {
  return remoteOs === 'windows' || remoteOs === 'macos';
}

export interface ChordRoutingInput {
  /** Agent modifier names for the chord, after any Cmd↔Ctrl remap. */
  modifiers: string[];
  /** Keys the viewer has sent key_down for and not yet released. */
  heldKeys: ReadonlySet<string>;
  remoteOs: string | null;
  viewerOs: ViewerOs;
  /** The physical Cmd/Meta key is down on the viewer (KeyboardEvent.metaKey). */
  physicalMeta: boolean;
  /** Cmd↔Ctrl remap is on, so an agent `meta` came from the physical Ctrl key. */
  remapActive: boolean;
}

/**
 * How to send a non-modifier key pressed while modifiers are down (K5).
 *
 * 'key_press' asks the agent to press the modifiers, the key, and release
 * everything. When the modifiers are already held on the remote (we sent their
 * key_down), the Windows and Linux agents release them as part of that chord,
 * so the remote's Shift goes up while the operator is still holding it and the
 * next Shift+click loses Shift. 'held' sends only key_down/key_up for the key
 * and leaves the held modifiers alone.
 *
 * 'held' is used only for Windows remotes. key_press is kept where 'held'
 * would break or change what the operator gets today:
 *  - macOS remotes: that agent cannot hold a modifier via key_down.
 *  - Linux remotes: a raw key_down skips the Shift a layout needs for the
 *    keysym, which key_press adds. Fixed agent-side in W2.
 *  - Mac viewers with Cmd down: macOS never delivers the keyup for a key
 *    released while Cmd is held, so a key_down would stay down on the remote.
 *  - a remapped `meta` (physical Ctrl): bundled in key_press the Windows agent
 *    injects it as Ctrl, held via key_down it is the Win key.
 *  - any modifier we never saw go down (pressed before the viewer had focus).
 */
export function chordRouting(input: ChordRoutingInput): 'key_press' | 'held' {
  const { modifiers, heldKeys, remoteOs, viewerOs, physicalMeta, remapActive } = input;
  if (modifiers.length === 0) return 'key_press';
  if (remoteOs !== 'windows') return 'key_press';
  if (viewerOs === 'macos' && physicalMeta) return 'key_press';
  if (remapActive && modifiers.includes('meta')) return 'key_press';
  return modifiers.every((m) => heldKeys.has(m)) ? 'held' : 'key_press';
}

/**
 * A push this soon after the operator sent a copy chord in this window belongs
 * to that copy, even if they have since switched away (copy, then Alt-Tab).
 * The agent polls every 500 ms (and, with changeNotices, reads at once after
 * an injected copy chord).
 */
export const REMOTE_CLIPBOARD_COPY_INTENT_MS = 2000;
/**
 * A push this soon after the operator's last key or click forwarded to the
 * remote, in the focused window, follows something they just did there
 * (#11310). Outside it, the push is held for a one-click pull.
 */
export const REMOTE_CLIPBOARD_INPUT_RECENCY_MS = 2000;
/** The agent pushes the remote clipboard's existing contents on its first poll after the channel opens. */
export const REMOTE_CLIPBOARD_BASELINE_WINDOW_MS = 3000;

export interface RemoteClipboardState {
  now: number;
  hasFocus: boolean;
  /** When the operator last sent a key or click to the remote in this window (countsAsOperatorInput). */
  lastInputAt: number | null;
  /** When the operator last sent a copy chord (isCopyChord) in this window. */
  lastCopyIntentAt: number | null;
  channelOpenedAt: number | null;
  /** Remote pushes received on this channel before this one. */
  pushesSeen: number;
  /**
   * The agent's clipboard status said it records the connect-time clipboard
   * instead of sending it (W4a). The baseline skip is then only a fallback for
   * agents that predate it, and skipping would drop a real copy.
   */
  suppressesBaseline?: boolean;
}

/**
 * Whether a remote→local clipboard push is written to the local clipboard
 * now ('apply') or held for the operator to pull from the toolbar ('hold').
 *
 * A remote clipboard change overwrites the operator's clipboard only when it
 * follows something the operator just did in this session: a copy chord in
 * this window in the last 2 s, or, in the focused window, any key or click in
 * the last 2 s (#11310). Focus alone is not enough: a remote change while the
 * operator is reading the screen, or working in another app with this window
 * still frontmost, would overwrite what they had copied locally.
 *
 * A background window never applies on input recency (C1): one customer's
 * clipboard must not reach the technician's clipboard while they work in
 * another customer's session, and a "used a moment ago" grace cannot tell the
 * operator's copy from the end user's copy made just after the switch. A copy
 * chord can: the operator asked for that clipboard.
 *
 * The first push right after the channel opens is whatever the end user had
 * copied before the session started, not something copied during it. Writing
 * it would overwrite the technician's clipboard just for connecting.
 */
export function remoteClipboardDecision(
  s: RemoteClipboardState,
): 'apply' | 'skip-baseline' | 'hold' {
  if (
    !s.suppressesBaseline &&
    s.pushesSeen === 0 &&
    s.channelOpenedAt !== null &&
    s.now - s.channelOpenedAt < REMOTE_CLIPBOARD_BASELINE_WINDOW_MS
  ) {
    return 'skip-baseline';
  }
  if (s.lastCopyIntentAt !== null && s.now - s.lastCopyIntentAt <= REMOTE_CLIPBOARD_COPY_INTENT_MS) return 'apply';
  if (s.hasFocus && s.lastInputAt !== null && s.now - s.lastInputAt <= REMOTE_CLIPBOARD_INPUT_RECENCY_MS) return 'apply';
  return 'hold';
}

const OPERATOR_INPUT_TYPES = new Set(['key_down', 'key_press', 'mouse_down', 'mouse_click']);

/**
 * Whether an input event sent to the remote is the operator acting in the
 * session, for remoteClipboardDecision: a key or a click. Releases, motion,
 * scrolling and resets are not; the viewer sends releases on its own.
 */
export function countsAsOperatorInput(event: { type?: unknown }): boolean {
  return typeof event.type === 'string' && OPERATOR_INPUT_TYPES.has(event.type);
}

export type ViewerShortcut = 'fullscreen' | 'paste-keystrokes' | 'release-keys';

const SHORTCUT_BY_CODE: Record<string, ViewerShortcut> = {
  KeyF: 'fullscreen',
  KeyV: 'paste-keystrokes',
  KeyR: 'release-keys',
};

type ModifierState = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

/**
 * The viewer's own shortcuts, behind one prefix chord that remote apps do not
 * use (K8): Ctrl+Alt+Shift on Windows/Linux, Ctrl+Opt+Cmd on macOS. Every
 * shortcut the viewer keeps is one the remote can never receive. The old
 * Ctrl/Cmd+Shift+V and +F took paste-as-plain-text and Find in Files.
 */
export function viewerShortcut(e: ModifierState, viewerOs: ViewerOs): ViewerShortcut | null {
  const prefix = viewerOs === 'macos'
    ? e.ctrlKey && e.altKey && e.metaKey && !e.shiftKey
    : e.ctrlKey && e.altKey && e.shiftKey && !e.metaKey;
  if (!prefix) return null;
  return SHORTCUT_BY_CODE[e.code] ?? null;
}

export function shortcutLabel(key: string, viewerOs: ViewerOs): string {
  return viewerOs === 'macos' ? `⌃⌥⌘${key}` : `Ctrl+Alt+Shift+${key}`;
}

/**
 * Chords that paste on the remote, so the local clipboard must reach it first
 * (C3). Shift+Insert is the paste binding in terminals and older Windows apps.
 * AltGr arrives as Ctrl+Alt, so an Alt chord is not treated as a paste.
 */
export function isPasteChord(e: ModifierState): boolean {
  if (e.altKey) return false;
  if (e.code === 'KeyV') return e.ctrlKey || e.metaKey;
  if (e.code === 'Insert') return e.shiftKey && !e.ctrlKey && !e.metaKey;
  return false;
}

/** Chords that copy on the remote: Ctrl/Cmd+C, Ctrl/Cmd+X, Ctrl+Insert. */
export function isCopyChord(e: ModifierState): boolean {
  if (e.altKey) return false;
  if (e.code === 'KeyC' || e.code === 'KeyX') return e.ctrlKey || e.metaKey;
  if (e.code === 'Insert') return e.ctrlKey && !e.shiftKey && !e.metaKey;
  return false;
}
