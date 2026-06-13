import { useState, useEffect, useCallback, useRef } from 'react';
import { AlertTriangle, CheckCircle, X, Undo2, XCircle } from 'lucide-react';

interface ToastData {
  id: string;
  message: string;
  type: 'success' | 'error' | 'undo' | 'warning';
  onUndo?: () => void;
  duration?: number;
}

// Identical toasts (same type+message) emitted within this window collapse into
// one. This kills the "double success toast" papercut (#1301) regardless of the
// emit source — a double-mounted/view-transition-overlapped container, a
// StrictMode double-invoke, or a caller that fires twice — without suppressing
// legitimately-repeated actions (e.g. clicking "Save" again seconds later, which
// users expect to re-confirm). Undo toasts are never collapsed: they carry a
// distinct per-invocation onUndo callback, so two "Decommissioning…" toasts
// genuinely target two different rows and must both stay actionable.
const DEDUPE_WINDOW_MS = 1000;

let addToastFn: ((toast: Omit<ToastData, 'id'>) => void) | null = null;
const pendingToasts: Array<Omit<ToastData, 'id'>> = [];

export function showToast(toast: Omit<ToastData, 'id'>) {
  if (addToastFn) {
    addToastFn(toast);
  } else {
    pendingToasts.push(toast);
  }
}

// Visible for tests so each case starts with no carried-over queue state.
export function _resetToastQueueForTests() {
  pendingToasts.length = 0;
  addToastFn = null;
}

export default function ToastContainer() {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  // Tracks the last time each (type|message) key was shown, so we can collapse a
  // burst of identical toasts. A ref (not state) keeps this out of the render
  // cycle and survives across addToast calls without re-subscribing the effect.
  const recentToastsRef = useRef<Map<string, number>>(new Map());

  const addToast = useCallback((toast: Omit<ToastData, 'id'>) => {
    // Undo toasts always render — each carries a unique onUndo for a distinct
    // target row and must stay individually actionable.
    if (toast.type !== 'undo') {
      const key = `${toast.type}|${toast.message}`;
      const now = Date.now();
      const last = recentToastsRef.current.get(key);
      if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
        recentToastsRef.current.set(key, now);
        return; // identical toast already shown moments ago — drop the duplicate
      }
      recentToastsRef.current.set(key, now);
      // Opportunistically prune stale keys so the map can't grow unbounded over a
      // long-lived session.
      if (recentToastsRef.current.size > 50) {
        for (const [k, t] of recentToastsRef.current) {
          if (now - t >= DEDUPE_WINDOW_MS) recentToastsRef.current.delete(k);
        }
      }
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts(prev => [...prev, { ...toast, id }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, toast.duration || 5000);
  }, []);

  useEffect(() => {
    addToastFn = addToast;
    const queued = pendingToasts.splice(0, pendingToasts.length); // snapshot+clear, no destructive drain mid-loop
    queued.forEach(addToast);
    return () => { if (addToastFn === addToast) addToastFn = null; }; // don't clobber a newer registration
  }, [addToast]);

  const dismiss = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2" data-testid="toast-container">
      {toasts.map(toast => {
        const isError = toast.type === 'error';
        const isWarning = toast.type === 'warning';
        return (
          <div
            key={toast.id}
            role={isError ? 'alert' : 'status'}
            aria-live={isError ? 'assertive' : 'polite'}
            aria-atomic="true"
            data-testid="toast"
            data-toast-type={toast.type}
            className={`flex items-center gap-3 rounded-lg border px-4 py-3 shadow-lg animate-in ${
              isError
                ? 'bg-destructive text-destructive-foreground border-destructive/40'
                : isWarning
                  ? 'bg-card border-warning/50'
                  : 'bg-card'
            }`}
            style={{ minWidth: 280, maxWidth: 400 }}
          >
            {isError ? (
              <XCircle className="h-4 w-4 shrink-0" />
            ) : isWarning ? (
              <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
            ) : (
              <CheckCircle className="h-4 w-4 shrink-0 text-success" />
            )}
            <span className={`flex-1 text-sm ${isError ? '' : 'text-foreground'}`}>{toast.message}</span>
            {toast.type === 'undo' && toast.onUndo && (
              <button
                type="button"
                onClick={() => { toast.onUndo?.(); dismiss(toast.id); }}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-primary hover:bg-muted transition-colors"
              >
                <Undo2 className="h-3 w-3" />
                Undo
              </button>
            )}
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
              className={`rounded p-0.5 transition-colors ${
                isError
                  ? 'text-destructive-foreground/70 hover:text-destructive-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
