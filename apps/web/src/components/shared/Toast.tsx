import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, CheckCircle, X, Undo2, XCircle } from 'lucide-react';

interface ToastData {
  id: string;
  message: string;
  type: 'success' | 'error' | 'undo' | 'warning';
  onUndo?: () => void;
  duration?: number;
}

// Single module-level emitter slot: only one ToastContainer is ever the
// registered emitter at a time (see the effect below — a second mount overwrites
// rather than adds a listener). This is why showToast cannot fan a single call
// out to multiple toasts. The "duplicate success toasts" reported in #1301 were
// an Astro/Vite *dev-server* render double-invoke (no <StrictMode> in the app;
// prod ships production React), verified absent in a production build. Do NOT
// add a time-window dedupe here to "fix" duplicates — it silently drops two
// legitimately-distinct identical successes (e.g. two quick "Saved" toasts). The
// rejected PR #1332 took that path; the call-count guard in runAction.test.ts
// asserts the real single-emit invariant instead.
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

  const addToast = useCallback((toast: Omit<ToastData, 'id'>) => {
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
    // Bottom-right, but lifted on lg+ so the toast clears the quote editor's
    // sticky right-rail (Live totals + Terms panel) whose lower controls the
    // stock bottom-6 anchor visually overlapped on shorter viewports. z-index was
    // never the issue — the toast sat on top of the rail's interactive controls;
    // raising the anchor keeps bottom-right while leaving the rail usable. The
    // extra lift on wide screens is harmless on pages without a right rail.
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 lg:bottom-24" data-testid="toast-container">
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
