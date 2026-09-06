import {
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  type ReactNode,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { acquireScrollLock } from './scrollLock';

// Reference counter for stacked dialogs — only restore scroll when all dialogs close

type DialogMaxWidth = 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl';

const maxWidthClass: Record<DialogMaxWidth, string> = {
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
};

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/* Gesture-tail guard (#3705).
 *
 * A dialog closes by tearing its portal out of the DOM, so on a REAL
 * double-click the second physical press is hit-tested AFTER the backdrop is
 * gone — against whatever now occupies those coordinates. Confirm buttons sit
 * centred over dense list and grid layouts whose rows carry live actions, so
 * the hazard is not a duplicate of the action just confirmed; it is an
 * UNRELATED action firing from the second half of the gesture.
 *
 * The discriminator is `MouseEvent.detail`, the platform click counter. It is
 * computed from the button, the time and the distance between presses rather
 * than from the DOM target, so the second press still reports `detail === 2`
 * even though it now lands on a different element.
 *
 * Confidence, honestly graded, because the whole guard leans on this: verified
 * in Chromium source (`ui/events/event.cc` gates only on matching button flags,
 * elapsed time and a <=2px position delta) and in WebKit, which on macOS simply
 * copies `NSEvent.clickCount` and so is even further from the DOM. Gecko is
 * asserted from observed behaviour, not from source. None of it is normative
 * either way — UI Events defines the counter but never says a change of target
 * must leave it alone. The latch in ConfirmDialog is the belt to these braces.
 *
 * A deliberate NEW double-click after the dialog closed begins with a press
 * whose `detail` is 1, which stands the guard down before its own second press
 * arrives — so intentional double-clicks keep working. That is also what bounds
 * the guard's lifetime: it retires on the next fresh press rather than on a
 * timer, because OS double-click intervals are configurable (the Win32
 * double-click-time API clamps at 5s, well past the ~900ms the Windows control
 * panel exposes) and any fixed ceiling would either expire before the second
 * press or linger well past it.
 *
 * KNOWN TRADE-OFF. The counter cannot distinguish "second half of an
 * accidental double-click" from "deliberate fast click at the same spot right
 * after confirming" — both arrive as `detail >= 2`, and the second one is
 * therefore swallowed. Recovery does not require waiting: any press the
 * platform counts as fresh clears the guard, so a click anywhere far enough
 * away — or the same click repeated a moment later — goes straight through.
 * Because the counter only increments for presses within a few pixels of the
 * last one, that costs at most a repeated click at the coordinates the confirm
 * button just vacated, and it errs on the side of not firing a destructive
 * command the user did not aim at.
 *
 * That includes across a client-side route change: the platform counter is not
 * reset by SPA navigation, so if `onConfirm` navigates and the new screen puts
 * a control where the confirm button was, the user's first click on it can be
 * counted as the second of a pair and swallowed. Scoping the guard by
 * coordinates would not help — a `detail >= 2` event is already, by
 * construction, within a few pixels of the click that armed it. Clicking again
 * works, which is the same recovery as every other case above. The place most likely to feel
 * it is the remote FileManager, whose table rows are double-click-to-open and
 * reflow underneath a delete confirm.
 *
 * SCOPE — deliberately narrow. This blocks the mouse/click activation tail and
 * nothing else. Handlers bound to `pointerdown`/`pointerup` are NOT covered:
 * those report `detail === 0` in current engines (de-facto again — w3c/pointer
 * events#98 is still open on whether that is required), so the same
 * discriminator cannot classify them, and suppressing them wholesale would eat
 * the opening press of a legitimate new gesture and interfere with pointer
 * capture and dragging. Keyboard- and AT-synthesised clicks also report 0 and
 * pass through untouched, by design — that one IS normative, since a click
 * dispatched with no underlying native event initialises `detail` to 0.
 */
const GUARDED_EVENTS = ['mousedown', 'mouseup', 'click', 'dblclick'] as const;

let disarmActiveGestureTailGuard: (() => void) | null = null;

function armGestureTailGuard() {
  if (typeof document === 'undefined') return;
  // Stacked dialogs: only ever one guard installed.
  disarmActiveGestureTailGuard?.();

  const disarm = () => {
    for (const type of GUARDED_EVENTS) document.removeEventListener(type, onEvent, true);
    if (disarmActiveGestureTailGuard === disarm) disarmActiveGestureTailGuard = null;
  };

  // `UIEvent`, not React's imported `MouseEvent` — these are native events.
  function onEvent(e: Event) {
    if ((e as UIEvent).detail >= 2) {
      e.preventDefault();
      e.stopPropagation();
      // React attaches its listener to the root container, a descendant of
      // document, so stopping here in the capture phase means the tail of the
      // gesture never reaches any handler underneath.
      e.stopImmediatePropagation();
      return;
    }
    // detail <= 1 — a genuinely new gesture. Stand down and let it through.
    if (e.type === 'mousedown' || e.type === 'click') disarm();
  }

  for (const type of GUARDED_EVENTS) document.addEventListener(type, onEvent, true);
  disarmActiveGestureTailGuard = disarm;
}

/** How long after a COMPLETED click inside the dialog a teardown still counts
 *  as caused by that click. Only decides whether to ARM; the guard's own
 *  lifetime is bounded by the next fresh press, not by this.
 *
 *  Deliberately keyed on `click`, not `mousedown`: a press that never completes
 *  a click inside the dialog — starting a text selection, then dismissing with
 *  Escape — leaves no gesture tail to guard against, and arming there would
 *  only create the opposite bug. A completed click immediately followed by an
 *  Escape close inside this window does still arm; that costs one ignored click
 *  at the vacated coordinates, the same trade-off documented above. */
const CLICK_CAUSED_CLOSE_MS = 150;

// The portal must be gone before the guard is installed, and the listener must
// be in place before the browser dispatches the next press. A layout effect's
// cleanup runs inside the commit, which is both; a passive one runs after.
const useIsomorphicLayoutEffect = typeof document !== 'undefined' ? useLayoutEffect : useEffect;

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Accessible label (used as aria-label). Ignored when `labelledBy` is set. */
  title: string;
  /** Id of a visible heading inside the dialog. When provided, the dialog is
   *  named via `aria-labelledby` instead of `aria-label`, so a screen reader
   *  doesn't announce the same text twice (once as the dialog name, once as the
   *  visible heading). */
  labelledBy?: string;
  /** Maps to Tailwind max-w-{value}. Default: 'lg' */
  maxWidth?: DialogMaxWidth;
  /** Top-align instead of center (for tall content that scrolls the backdrop) */
  alignTop?: boolean;
  /** Classes on the dialog panel (e.g. 'p-6', 'flex flex-col max-h-[90vh]') */
  className?: string;
  children: ReactNode;
}

export function Dialog({
  open,
  onClose,
  title,
  labelledBy,
  maxWidth = 'lg',
  alignTop = false,
  className = '',
  children,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement;
    const raf = requestAnimationFrame(() => {
      if (!panelRef.current) return;
      const first = panelRef.current.querySelector<HTMLElement>(FOCUSABLE);
      if (first) first.focus();
      else panelRef.current.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const release = acquireScrollLock();
    return release;
  }, [open]);

  // #3705: arm the guard as the portal is torn out — but ONLY when a completed
  // click inside the dialog could plausibly have caused the teardown (Confirm,
  // Cancel, a backdrop click). Escape with no completed click, a slow async
  // settle and a route change all leave the guard off, and arming after those
  // would let it eat a deliberate click or leak into whatever screen renders
  // next. StrictMode's extra setup/cleanup cycle is filtered out by the same
  // test, since `lastClickInsideAtRef` is still 0 at mount.
  //
  // "Plausibly" is doing real work here: this is a time window, not causation.
  // An action that settles and closes the dialog in under CLICK_CAUSED_CLOSE_MS
  // still arms. That is the conservative direction — the cost is the same one
  // ignored click documented above, at coordinates the user just clicked.
  const lastClickInsideAtRef = useRef(0);
  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    return () => {
      if (Date.now() - lastClickInsideAtRef.current < CLICK_CAUSED_CLOSE_MS) {
        armGestureTailGuard();
      }
    };
  }, [open]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onClose],
  );

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className={`dialog-backdrop fixed inset-0 z-50 flex ${
        alignTop ? 'items-start overflow-y-auto' : 'items-center'
      } justify-center bg-background/80 px-4 py-8`}
      style={{ animation: 'dialog-backdrop-in 150ms ease-out' }}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      onClickCapture={() => {
        lastClickInsideAtRef.current = Date.now();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        {...(labelledBy ? { 'aria-labelledby': labelledBy } : { 'aria-label': title })}
        tabIndex={-1}
        className={`dialog-panel w-full ${maxWidthClass[maxWidth]} rounded-lg border bg-card shadow-lg focus:outline-hidden ${className}`}
        style={{ animation: 'dialog-panel-in 200ms cubic-bezier(0.25, 1, 0.5, 1)' }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
