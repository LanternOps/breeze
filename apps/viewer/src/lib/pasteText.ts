/**
 * Paste Text delivery (issue #4089).
 *
 * Paste used to be per-character keystroke synthesis: `textToKeyEvents` turned
 * the clipboard into one `key_press` per character and the agent replayed each
 * through a hardcoded US-ANSI QWERTY keycode table. On a remote machine whose
 * active input source is not US ANSI that table produces the *wrong* characters
 * — `/` arriving as `?`, `=` as `+` — which silently corrupts pasted shell
 * commands.
 *
 * An agent that advertises `typeText` instead receives the literal string in a
 * `type_text` control message and injects it verbatim (macOS
 * CGEventKeyboardSetUnicodeString, Windows KEYEVENTF_UNICODE), so the remote
 * layout never enters into it.
 *
 * Two deliberate choices:
 *
 *  - It rides the CONTROL channel, not the input channel. The input channel is
 *    created with `maxRetransmits: 0` (see webrtc.ts) so a lost datagram is
 *    never retransmitted — the right trade for a mouse move, the wrong one for
 *    a paste, where one dropped message silently truncates a shell command.
 *  - The key-synthesis path stays as the fallback. The viewer auto-updates
 *    independently of the agent fleet, so a new viewer routinely talks to an
 *    agent that predates `type_text`; without the fallback those sessions would
 *    paste nothing at all instead of pasting imperfectly.
 */

import { textToKeyEvents, type PasteKeyEvent } from './paste';

/**
 * Max UTF-16 code units per `type_text` message.
 *
 * The agent rejects control messages over 32 KiB (`maxControlMessageBytes` in
 * agent/internal/remote/desktop/session_control.go). JSON escaping costs at most
 * 6 bytes per UTF-16 unit (`\uXXXX`), so 2000 units cannot exceed ~12 KiB on the
 * wire — comfortable headroom, and small enough that the progress indicator
 * still moves on a large paste.
 */
export const TYPE_TEXT_CHUNK_UNITS = 2000;

/**
 * Turn the agent's `type_text_result` failure report into something an MSP
 * technician can act on.
 *
 * The progress indicator completes on *send*, not on delivery, so without this
 * a paste the agent dropped looks exactly like one that worked — and the
 * operator goes on believing the remote machine holds what their clipboard
 * holds. The agent only sends this message on failure.
 */
export function pasteFailureMessage(result: { reason?: unknown; error?: unknown }): string {
  switch (result.reason) {
    case 'input_unavailable':
      return 'Paste failed: the remote machine is not accepting input right now (it may be at the login window).';
    case 'injection_failed': {
      const detail = typeof result.error === 'string' && result.error ? ` (${result.error})` : '';
      return `Paste may be incomplete — the remote machine rejected part of the text${detail}.`;
    }
    default:
      return 'Paste failed — the remote machine did not accept the text.';
  }
}

export interface PasteTextDeps {
  /** The clipboard text to deliver. */
  text: string;
  /** Whether the connected agent answered the input_capabilities handshake with typeText. */
  supportsTypeText: boolean;
  /** Sends a JSON string on the reliable control channel, or null when there isn't one. */
  sendControl: ((json: string) => void) | null;
  /** Sends one synthesised key event on the input channel (the fallback path). */
  sendInput: (event: PasteKeyEvent) => void;
  /** Reports progress to the toolbar; null clears the indicator. */
  onProgress: (progress: { current: number; total: number } | null) => void;
  /** True once the operator has cancelled the paste. */
  isCancelled: () => boolean;
  /** Yields to the event loop so the UI stays responsive mid-paste. */
  yieldToUi: () => Promise<void>;
  /** Override for the chunk size; tests only. */
  chunkUnits?: number;
}

/**
 * Split text into chunks of at most `maxUnits` UTF-16 code units, never
 * splitting a surrogate pair across a boundary — a split pair would arrive as
 * two replacement characters. A single astral character is emitted whole even
 * when it exceeds the cap, so a chunk may be one unit over rather than corrupt.
 */
export function chunkTextForInjection(text: string, maxUnits: number = TYPE_TEXT_CHUNK_UNITS): string[] {
  if (!text) return [];
  const limit = Math.max(1, Math.floor(maxUnits));

  const chunks: string[] = [];
  let current = '';
  // for..of over a string iterates whole code points, so an astral character is
  // never split even though `.length` counts UTF-16 units.
  for (const codePoint of text) {
    if (current.length > 0 && current.length + codePoint.length > limit) {
      chunks.push(current);
      current = '';
    }
    current += codePoint;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Deliver `text` to the remote machine, preferring literal text injection and
 * falling back to per-character key synthesis. Rejects if the underlying send
 * throws, but always clears the progress indicator first.
 */
export async function sendPasteText(deps: PasteTextDeps): Promise<void> {
  const {
    text,
    supportsTypeText,
    sendControl,
    sendInput,
    onProgress,
    isCancelled,
    yieldToUi,
    chunkUnits = TYPE_TEXT_CHUNK_UNITS,
  } = deps;

  if (!text) return;

  if (supportsTypeText && sendControl) {
    const chunks = chunkTextForInjection(text, chunkUnits);
    onProgress({ current: 0, total: chunks.length });
    try {
      for (let i = 0; i < chunks.length; i++) {
        if (isCancelled()) break;
        sendControl(JSON.stringify({ type: 'type_text', text: chunks[i] }));
        onProgress({ current: i + 1, total: chunks.length });
        if (i + 1 < chunks.length) await yieldToUi();
      }
    } finally {
      onProgress(null);
    }
    return;
  }

  const events = textToKeyEvents(text);
  onProgress({ current: 0, total: events.length });
  try {
    for (let i = 0; i < events.length; i++) {
      if (isCancelled()) break;
      sendInput(events[i]);

      if (i % 20 === 0) {
        onProgress({ current: i + 1, total: events.length });
        // Yield every 20 chars so the UI stays responsive.
        await yieldToUi();
      }
    }
  } finally {
    onProgress(null);
  }
}
