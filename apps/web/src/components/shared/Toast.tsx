import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, CheckCircle, X, Undo2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

interface ToastData {
  id: string;
  message: string;
  type: 'success' | 'error' | 'undo' | 'warning';
  onUndo?: () => void;
  duration?: number;
}

// Single emitter slot: only one ToastContainer is ever the registered emitter at
// a time (see the effect below — a second mount overwrites rather than adds a
// listener). This is why showToast cannot fan a single call out to multiple
// toasts. The "duplicate success toasts" reported in #1301 were an Astro/Vite
// *dev-server* render double-invoke (no <StrictMode> in the app; prod ships
// production React), verified absent in a production build. Do NOT add a
// time-window dedupe here to "fix" duplicates — it silently drops two
// legitimately-distinct identical successes (e.g. two quick "Saved" toasts). The
// rejected PR #1332 took that path; the call-count guard in runAction.test.ts
// asserts the real single-emit invariant instead.
//
// The slot and the pre-mount queue live on `globalThis`, NOT at module scope,
// because delivery must survive *module duplication*. Under Astro 7 / Vite 8 dev
// each astro-island gets its own module graph, so the island that calls
// showToast and the island that renders <ToastContainer /> can end up holding
// two different copies of this module. With module-scope state that split the
// emitter from the container: every toast queued into a `pendingToasts` array
// nothing ever drained, so app-wide runAction feedback silently vanished on the
// dev server (#2014). A production `astro build` dedupes this file into one
// shared chunk, which is why it only ever reproduced under `astro dev`.
// Keying off globalThis means all copies share one bus.
//
// Deliberately NOT a `window` CustomEvent bus (the other option floated on
// #2014): event listeners *accumulate*, so two simultaneously-mounted containers
// would each render the same emit and resurrect the #1301 double-toast symptom.
// One overwritable emitter slot stays the invariant — only its home changes.
interface ToastBus {
  emit: ((toast: Omit<ToastData, 'id'>) => void) | null;
  pending: Array<Omit<ToastData, 'id'>>;
}

// Version the key: a future shape change to ToastBus must not be handed a stale
// object left on globalThis by an older still-cached module copy during an HMR
// or partial-reload session.
type ToastBusHolder = typeof globalThis & { __breezeToastBus_v1?: ToastBus };

function toastBus(): ToastBus {
  const holder = globalThis as ToastBusHolder;
  const existing = holder.__breezeToastBus_v1;
  if (existing) return existing;
  const created: ToastBus = { emit: null, pending: [] };
  holder.__breezeToastBus_v1 = created;
  return created;
}

// Queueing while no container is mounted is LEGITIMATE (flush-on-mount, #720)
// — so queueing itself must not warn. But an unbounded queue is how #2014 stayed
// invisible: toasts piled up forever with no signal until a QA sweep noticed the
// missing feedback. A queue this deep means nothing is draining it, which is
// never normal, so cap it and say so out loud.
const MAX_PENDING_TOASTS = 50;

export function showToast(toast: Omit<ToastData, 'id'>) {
  const bus = toastBus();
  if (bus.emit) {
    bus.emit(toast);
    return;
  }
  bus.pending.push(toast);
  if (bus.pending.length > MAX_PENDING_TOASTS) {
    const dropped = bus.pending.shift();
    console.warn(
      `[Toast] ${MAX_PENDING_TOASTS}+ toasts queued with no ToastContainer registered — ` +
        'nothing is draining the queue, so action feedback is being lost. ' +
        'Is <ToastContainer /> mounted on this page (see DashboardLayout.astro)? ' +
        `Dropped oldest: ${dropped?.message ?? '(unknown)'}`
    );
  }
}

// Visible for tests so each case starts with no carried-over queue state.
export function _resetToastQueueForTests() {
  const bus = toastBus();
  bus.pending.length = 0;
  bus.emit = null;
}

export default function ToastContainer() {
  const { t } = useTranslation('common');
  const [toasts, setToasts] = useState<ToastData[]>([]);

  const addToast = useCallback((toast: Omit<ToastData, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts(prev => [...prev, { ...toast, id }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, toast.duration || 5000);
  }, []);

  useEffect(() => {
    const bus = toastBus();
    bus.emit = addToast;
    const queued = bus.pending.splice(0, bus.pending.length); // snapshot+clear, no destructive drain mid-loop
    queued.forEach(addToast);
    return () => { if (bus.emit === addToast) bus.emit = null; }; // don't clobber a newer registration
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
                {t('shared.toast.undo')}
              </button>
            )}
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label={t('shared.toast.dismiss')}
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
