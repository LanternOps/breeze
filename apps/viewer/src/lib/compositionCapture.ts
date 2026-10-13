// IME and dead-key capture for "Type what I see" (W06, #8242; spec gap K10).
//
// The viewer calls preventDefault on every keydown it forwards, which also
// blocks composition, so CJK input and dead-key accents could not be typed.
// With capture on, keyboard focus sits in a hidden <textarea> and this state
// machine decides, per event, whether the key goes to the remote as a key
// event ('forward', prevented as before) or is left to the browser
// ('capture'), in which case the text it produces is sent once as type_text.
//
// Rules (each unit-tested in compositionCapture.test.ts):
//  - Plain printable keys, chords and non-printables are forwarded: shortcuts
//    and terminals behave exactly as before. A forwarded keydown is prevented,
//    so it never produces a beforeinput: that is what keeps one keystroke from
//    being injected both as a key and as text.
//  - A keydown while composing (isComposing, or keyCode 229, which Chromium
//    reports for the key that opens a composition), a `Dead` keydown, and the
//    printable keydown right after a dead key are captured: not forwarded and
//    not prevented. Their keyups are suppressed too. A key pressed BEFORE a
//    composition started was forwarded, so its release is forwarded as well.
//  - Text is sent from compositionend (the commit) or from a non-composition
//    beforeinput insertText (Chromium's dead-key result). Updates while a
//    composition is open are ignored. An insertion that repeats the commit
//    just sent is dropped. Empty / cancelled compositions send nothing.
//  - Nothing is sent while capture is disabled (Physical keys, no typeText).
//
// Event orderings assumed (not verified against real WebView2 / WKWebView
// IMEs in CI; that is a lab check):
//  - Chromium (WebView2): keydown 229 → compositionstart → beforeinput
//    insertCompositionText… → compositionend(data). Dead keys: keydown 'Dead'
//    → keydown <char> → beforeinput insertText(<composed>).
//  - WebKit (WKWebView): dead keys open a composition (compositionstart with
//    the accent, compositionend with the composed char); an
//    insertFromComposition may arrive before or after compositionend.
//
// Typed or composed text is never logged.

import { chunkTextForInjection, TYPE_TEXT_CHUNK_UNITS } from './pasteText';

export interface CaptureKeyEvent {
  key: string;
  code: string;
  keyCode: number;
  isComposing: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface CompositionCaptureDeps {
  /** Delivers committed text (type_text). Called once per commit. */
  sendText: (text: string) => void;
  /** Capture is on: "Type what I see", WebRTC, agent with typeText. */
  enabled: () => boolean;
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock']);

/** One printable character (a code point), as produced by a key. */
function isPrintable(key: string): boolean {
  return [...key].length === 1;
}

export class CompositionCapture {
  private isComposingNow = false;
  private deadPending = false;
  private readonly suppressed = new Set<string>();
  /** The last committed text, to drop an insertion that repeats it. */
  private lastCommit: string | null = null;

  constructor(private readonly deps: CompositionCaptureDeps) {}

  composing(): boolean {
    return this.isComposingNow;
  }

  keyDown(e: CaptureKeyEvent): 'forward' | 'capture' {
    if (!this.deps.enabled()) return 'forward';
    if (this.isComposingNow || e.isComposing || e.keyCode === 229) return this.suppress(e);
    // A new keystroke outside a composition: a later insertion is not a repeat.
    this.lastCommit = null;
    if (e.key === 'Dead') {
      this.deadPending = true;
      return this.suppress(e);
    }
    // A modifier between the dead key and the letter (´ then Shift+E for É)
    // keeps the dead state: it is forwarded, so its release is too.
    if (this.deadPending && MODIFIER_KEYS.has(e.key)) return 'forward';
    if (this.deadPending) {
      this.deadPending = false;
      if (isPrintable(e.key) && !e.ctrlKey && !e.metaKey) return this.suppress(e);
    }
    return 'forward';
  }

  keyUp(e: CaptureKeyEvent): 'forward' | 'suppress' {
    if (e.code && this.suppressed.delete(e.code)) return 'suppress';
    return 'forward';
  }

  compositionStart(): void {
    this.isComposingNow = true;
    this.deadPending = false;
    this.lastCommit = null;
  }

  compositionEnd(data: string | null | undefined): void {
    this.isComposingNow = false;
    this.deadPending = false;
    if (!data) return;
    this.emit(data);
  }

  /**
   * Decide what to do with a beforeinput on the hidden input. Composition
   * updates cannot be cancelled and are left alone; everything else is
   * prevented so the input never accumulates text.
   */
  beforeInput(inputType: string, data: string | null, isComposing: boolean): { preventDefault: boolean } {
    if (this.isComposingNow || isComposing || inputType === 'insertCompositionText') {
      return { preventDefault: false };
    }
    if ((inputType === 'insertText' || inputType === 'insertFromComposition') && data) {
      if (data === this.lastCommit) {
        this.lastCommit = null;
      } else {
        this.deadPending = false;
        this.emit(data);
      }
    }
    return { preventDefault: true };
  }

  /** Forget composing / dead-key state and suppressed keys (blur, mode change). */
  reset(): void {
    this.isComposingNow = false;
    this.deadPending = false;
    this.suppressed.clear();
    this.lastCommit = null;
  }

  private suppress(e: CaptureKeyEvent): 'capture' {
    if (e.code) this.suppressed.add(e.code);
    return 'capture';
  }

  private emit(text: string): void {
    if (!this.deps.enabled()) return;
    this.lastCommit = text;
    this.deps.sendText(text);
  }
}

/**
 * Sends composed text as type_text on the control channel, chunked like Paste
 * Text. Returns false when it could not be sent, so the caller can tell the
 * operator rather than drop it silently. There is no key-synthesis fallback:
 * composed text (CJK, accents) has no US-layout keystroke equivalent.
 */
export function deliverComposedText(
  text: string,
  sendControl: ((json: string) => void) | null,
  chunkUnits: number = TYPE_TEXT_CHUNK_UNITS,
): boolean {
  if (!text) return true;
  if (!sendControl) return false;
  try {
    for (const chunk of chunkTextForInjection(text, chunkUnits)) {
      sendControl(JSON.stringify({ type: 'type_text', text: chunk }));
    }
    return true;
  } catch {
    return false;
  }
}
