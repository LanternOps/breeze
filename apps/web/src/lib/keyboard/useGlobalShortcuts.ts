import { useEffect, useRef } from 'react';
import { navigateTo } from '@/lib/navigation';
import { useUiStore } from '../../stores/uiStore';
import { GO_TO_BY_KEY } from './goToShortcuts';

/** Window event the Sidebar listens for to cycle open → hover → collapsed. */
export const SIDEBAR_CYCLE_MODE_EVENT = 'breeze:sidebar-cycle-mode';
/** How long after pressing `g` the second key of a chord is accepted. */
export const CHORD_TIMEOUT_MS = 1000;

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

const CONTENT_EDITABLE = '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (EDITABLE_TAGS.has(target.tagName) || target.isContentEditable) return true;
  // jsdom never sets isContentEditable; real editors (CodeMirror, Monaco's
  // fallback) nest the caret element inside the editable root, so walk up.
  return target.closest(CONTENT_EDITABLE) !== null;
}

/**
 * App-wide single-key shortcuts, mounted once per authenticated page by
 * `GlobalShortcuts` (DashboardLayout).
 *
 * Two listeners with opposite precedence:
 * - The single keys (`g`, `/`, `?`, `[`) sit on `window` in the BUBBLE phase,
 *   so a page-local handler (the devices filter bar's own `/` and `?`, on
 *   `document`) runs first and wins by calling `preventDefault()`.
 * - The second key of a pending chord is taken in the CAPTURE phase and
 *   stopped there. Once the user has pressed `g`, the next key belongs to the
 *   chord: `g a` must go to Alerts, not also fire the ticket queue's single-key
 *   `a` (assign to me) — a page handler on `window` registered after this
 *   island would otherwise run second and act on the same keystroke.
 *
 *   g then <key>  navigate (see goToShortcuts.ts)
 *   /             open the command palette
 *   ?             toggle the shortcuts cheat sheet
 *   [             cycle the sidebar mode
 *
 * Nothing fires while typing (inputs, textareas, selects, contenteditable) or
 * with Cmd/Ctrl/Alt held — those belong to the browser and to Cmd+K.
 */
export function useGlobalShortcuts(): void {
  const chordTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chordPending = useRef(false);

  useEffect(() => {
    const clearChord = () => {
      chordPending.current = false;
      if (chordTimer.current) {
        clearTimeout(chordTimer.current);
        chordTimer.current = null;
      }
    };

    // Capture phase: completes a pending chord before any page handler sees
    // the key. A key that is not a chord target just cancels the chord and
    // continues through the normal dispatch.
    const onChordCapture = (event: KeyboardEvent) => {
      if (!chordPending.current) return;
      if (event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) {
        clearChord();
        return;
      }
      clearChord();
      const target = GO_TO_BY_KEY.get(event.key);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const ui = useUiStore.getState();
      if (ui.isShortcutsHelpOpen) ui.closeShortcutsHelp();
      void navigateTo(target.href);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;

      const ui = useUiStore.getState();

      switch (event.key) {
        case 'g':
          chordPending.current = true;
          chordTimer.current = setTimeout(clearChord, CHORD_TIMEOUT_MS);
          return;
        case '/':
          event.preventDefault();
          ui.openCommandPalette();
          return;
        case '?':
          event.preventDefault();
          ui.toggleShortcutsHelp();
          return;
        case '[':
          event.preventDefault();
          window.dispatchEvent(new Event(SIDEBAR_CYCLE_MODE_EVENT));
          return;
        default:
          return;
      }
    };

    window.addEventListener('keydown', onChordCapture, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onChordCapture, true);
      window.removeEventListener('keydown', onKeyDown);
      clearChord();
    };
  }, []);
}
