import { useUiStore } from '../../stores/uiStore';

/** A bare key (chord prefix, `/`, queue single key) only starts an action when
 *  no printable key arrived within this window. Normal typing runs well under
 *  it, so a letter in the middle of a word never fires a shortcut. */
export const TYPING_CADENCE_MS = 600;

/** `aria-labelledby` id of the shortcuts cheat sheet dialog. Shortcuts stay
 *  live inside it so `?` can still close it. */
const CHEAT_SHEET_LABEL_ID = 'keyboard-shortcuts-title';

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const CONTENT_EDITABLE = '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';
const INPUT_ROLES = '[role="textbox"],[role="combobox"],[role="searchbox"],[role="spinbutton"]';

function isInputLike(el: Element | null): boolean {
  if (!el) return false;
  if (EDITABLE_TAGS.has(el.tagName) || (el instanceof HTMLElement && el.isContentEditable)) return true;
  // jsdom never sets isContentEditable; real editors (CodeMirror, Monaco's
  // fallback) nest the caret element inside the editable root, so walk up.
  if (el.closest(CONTENT_EDITABLE) !== null) return true;
  const roled = el.closest(INPUT_ROLES);
  return roled !== null && roled.getAttribute('aria-readonly') !== 'true';
}

function isInsideBlockingDialog(el: Element | null): boolean {
  if (!el) return false;
  const dialog = el.closest('[aria-modal="true"],[role="dialog"],[role="alertdialog"]');
  if (!dialog) return false;
  return dialog.getAttribute('aria-labelledby') !== CHEAT_SHEET_LABEL_ID;
}

/** True when the keystroke belongs to an input, a combobox-style widget or a
 *  modal dialog rather than to page-level shortcuts. Checks the event target
 *  and the focused element (they differ for `window`-dispatched events). */
export function isTypingContext(event: KeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : null;
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  return (
    isInputLike(target) || isInputLike(active) ||
    isInsideBlockingDialog(target) || isInsideBlockingDialog(active)
  );
}

export function isPrintableKey(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
}

let lastPrintableAt = Number.NEGATIVE_INFINITY;
const verdicts = new WeakMap<KeyboardEvent, { typing: boolean; withinCadence: boolean }>();

/** Forget the typing history (the second key of a completed chord, tests). */
export function resetTypingCadence(): void {
  lastPrintableAt = Number.NEGATIVE_INFINITY;
}

/** Record a printable key without asking for a verdict. */
export function noteKeydown(event: KeyboardEvent): void {
  if (isPrintableKey(event)) lastPrintableAt = Date.now();
}

export interface BareKeyOptions {
  /** Skip the cadence check (read-only navigation keys such as queue `j`/`k`,
   *  which must keep working when held down). The key still counts as typing. */
  ignoreCadence?: boolean;
}

/**
 * Single entry point for every bare-key (no modifier) shortcut handler. Call
 * it once per keydown, BEFORE any early return, so the cadence clock sees every
 * printable key. Returns false when the key must be treated as typing:
 *  - focus is in an input-like element or an open dialog (see above), or
 *  - a printable key arrived in the previous `TYPING_CADENCE_MS`.
 * The verdict is memoised per event so two hooks can share one keystroke.
 * Dirty-form suppression is separate (`isFormDirtyBlocking`) because `?` is
 * exempt from it; the g/c chords and every queue key except Escape honour it.
 */
export function shouldHandleBareKey(event: KeyboardEvent, opts: BareKeyOptions = {}): boolean {
  // Compute once per event (so two hooks share one keystroke and the clock is
  // read before it is advanced), but keep the options out of the cache: the
  // verdict a caller gets must not depend on which hook ran first.
  let v = verdicts.get(event);
  if (!v) {
    const previous = lastPrintableAt;
    const printable = isPrintableKey(event);
    if (printable) lastPrintableAt = Date.now();
    v = {
      typing: isTypingContext(event),
      withinCadence: printable && Date.now() - previous < TYPING_CADENCE_MS,
    };
    verdicts.set(event, v);
  }
  if (v.typing) return false;
  return opts.ignoreCadence ? true : !v.withinCadence;
}

/** True while a mounted editor has registered unsaved input. */
export function isFormDirtyBlocking(): boolean {
  return useUiStore.getState().dirtyFormCount > 0;
}
