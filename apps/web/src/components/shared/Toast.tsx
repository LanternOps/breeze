import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, X, Undo2, XCircle } from 'lucide-react';

interface ToastData {
  id: string;
  message: string;
  type: 'success' | 'error' | 'undo';
  onUndo?: () => void;
  duration?: number;
}

let addToastFn: ((toast: Omit<ToastData, 'id'>) => void) | null = null;

export function showToast(toast: Omit<ToastData, 'id'>) {
  addToastFn?.(toast);
}

export default function ToastContainer() {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  const addToast = useCallback((toast: Omit<ToastData, 'id'>) => {
    const id = Date.now().toString();
    setToasts(prev => [...prev, { ...toast, id }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, toast.duration || 5000);
  }, []);

  useEffect(() => {
    addToastFn = addToast;
    return () => { addToastFn = null; };
  }, [addToast]);

  const dismiss = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`flex items-center gap-3 rounded-lg border px-4 py-3 shadow-lg animate-in ${
            toast.type === 'error'
              ? 'bg-destructive text-destructive-foreground border-destructive/40'
              : 'bg-card'
          }`}
          style={{ minWidth: 280, maxWidth: 400 }}
        >
          {toast.type === 'error' ? (
            <XCircle className="h-4 w-4 shrink-0" />
          ) : (
            <CheckCircle className="h-4 w-4 shrink-0 text-success" />
          )}
          <span className={`flex-1 text-sm ${toast.type === 'error' ? '' : 'text-foreground'}`}>{toast.message}</span>
          {toast.type === 'undo' && toast.onUndo && (
            <button
              onClick={() => { toast.onUndo?.(); dismiss(toast.id); }}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-primary hover:bg-muted transition-colors"
            >
              <Undo2 className="h-3 w-3" />
              Undo
            </button>
          )}
          <button
            onClick={() => dismiss(toast.id)}
            className={`rounded p-0.5 transition-colors ${
              toast.type === 'error'
                ? 'text-destructive-foreground/70 hover:text-destructive-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
