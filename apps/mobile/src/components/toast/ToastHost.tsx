import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from 'react';

import { Toast } from '../Toast';
import {
  TOAST_BACKSTOP_MS,
  toastReducer,
  topOutletId,
  type ToastEntry,
  type ToastRequest,
} from './toastState';

interface ToastContextValue {
  current: ToastEntry | null;
  show: (request: ToastRequest) => void;
  dismiss: (id: number) => void;
  topOutlet: number | null;
  registerOutlet: (id: number) => void;
  unregisterOutlet: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextToastId = 1;
let nextOutletId = 1;

/**
 * One toast host for the whole app.
 *
 * Every screen used to mount its own `<Toast>` and hand it a bottom offset
 * measured from whatever sat at the bottom of THAT screen — a composer, the
 * timer bar, a tab bar. The offsets were right on the screen they were tuned
 * for and wrong everywhere else, so "Timer started" landed on the ticket
 * composer's Reply / Internal note tabs, "Timer stopped" landed on the Ask
 * Breeze input, and "Comment added" covered the activity row it was announcing
 * (#5368, after #5105 and #5171 both tried to fix it one screen at a time).
 *
 * The host anchors to the TOP safe-area inset instead, where nothing else in
 * this app lives: below the status bar, above the screen headers, and out of
 * reach of composers, keyboards and the timer bar by construction rather than
 * by measurement. It is `pointerEvents="none"`, so it never eats a tap.
 *
 * Mounted INSIDE `AppLockGate` (so the lock screen and the privacy cover paint
 * over it — a toast must not leak a ticket subject onto a locked phone) and
 * OUTSIDE `RootNavigator` (so a toast survives the navigation that a decision
 * often triggers).
 */
export function ToastHost({ children }: { children: React.ReactNode }) {
  const [current, dispatch] = useReducer(toastReducer, null);
  const [outlets, setOutlets] = useState<readonly number[]>([]);

  const show = useCallback((request: ToastRequest) => {
    dispatch({ type: 'show', id: nextToastId++, request });
  }, []);

  const dismiss = useCallback((id: number) => {
    dispatch({ type: 'dismiss', id });
  }, []);

  const registerOutlet = useCallback((id: number) => {
    setOutlets((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const unregisterOutlet = useCallback((id: number) => {
    setOutlets((prev) => prev.filter((value) => value !== id));
  }, []);

  // Backstop for an exit animation whose completion callback never fires — see
  // TOAST_BACKSTOP_MS. Re-armed per toast id, so a replacement gets its own
  // full window.
  useEffect(() => {
    if (current === null) return;
    const id = current.id;
    const timer = setTimeout(() => dismiss(id), TOAST_BACKSTOP_MS);
    return () => clearTimeout(timer);
  }, [current, dismiss]);

  const value = useMemo<ToastContextValue>(
    () => ({
      current,
      show,
      dismiss,
      topOutlet: topOutletId(outlets),
      registerOutlet,
      unregisterOutlet,
    }),
    [current, show, dismiss, outlets, registerOutlet, unregisterOutlet]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastOutlet />
    </ToastContext.Provider>
  );
}

/**
 * `show({ kind, text })` from anywhere under the host. A second call replaces
 * whatever is on screen; the colours and the 1800ms hold are the same ones the
 * per-screen toasts used.
 *
 * `current` is exposed for the one caller that needs to reason about a toast it
 * queued (ApprovalScreen, whose empty-state branch waits on the decision
 * confirmation it just posted).
 *
 * `show` and `dismiss` are referentially stable for the life of the host, so
 * callers do not need to list them in `useCallback`/`useEffect` dependency
 * arrays (and none of the migrated screens do).
 */
export function useToast(): Pick<ToastContextValue, 'current' | 'show' | 'dismiss'> {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastHost>');
  const { current, show, dismiss } = ctx;
  return { current, show, dismiss };
}

/**
 * Where the toast paints. The host renders one at the root automatically; mount
 * another one inside an RN `Modal` that posts toasts of its own, since a Modal
 * always paints above the root host. Only the topmost mounted outlet renders
 * (see `topOutletId`), so the two never double up.
 */
export function ToastOutlet() {
  const ctx = useContext(ToastContext);
  const [id] = useState(() => nextOutletId++);
  const registerOutlet = ctx?.registerOutlet;
  const unregisterOutlet = ctx?.unregisterOutlet;

  useEffect(() => {
    if (!registerOutlet || !unregisterOutlet) return;
    registerOutlet(id);
    return () => unregisterOutlet(id);
  }, [id, registerOutlet, unregisterOutlet]);

  if (!ctx) throw new Error('<ToastOutlet> must be used inside <ToastHost>');
  const { current, dismiss, topOutlet } = ctx;
  if (current === null || topOutlet !== id) return null;

  return (
    <Toast
      // Remount on replacement so the enter animation and the hold timer
      // restart for the new message instead of inheriting the remainder of the
      // displaced one's window.
      key={current.id}
      text={current.text}
      kind={current.kind}
      onHidden={() => dismiss(current.id)}
    />
  );
}
