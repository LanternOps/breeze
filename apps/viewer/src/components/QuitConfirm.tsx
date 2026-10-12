import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

// macOS Cmd+Q with remote sessions open (K9, #8241). The Rust side emits
// `quit-requested` to one session window (the focused one) instead of quitting;
// this asks, and `confirm_quit` quits for real.

export interface QuitConfirmDeps {
  listenQuitRequested(cb: (sessions: number) => void): Promise<() => void>;
  confirmQuit(): Promise<void>;
}

const tauriDeps: QuitConfirmDeps = {
  // Scoped to this window: a global listen() would fire in every window.
  listenQuitRequested: (cb) =>
    getCurrentWebviewWindow().listen<number>('quit-requested', (e) => cb(typeof e.payload === 'number' ? e.payload : 1)),
  confirmQuit: () => invoke('confirm_quit'),
};

export function QuitConfirm({ deps = tauriDeps }: { deps?: QuitConfirmDeps }) {
  const [sessions, setSessions] = useState<number | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    deps.listenQuitRequested((n) => setSessions(n)).then(
      (fn) => {
        if (disposed) fn();
        else unlisten = fn;
      },
      (err) => console.warn('Quit confirmation unavailable:', err),
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [deps]);

  if (sessions === null) return null;

  const quit = () => {
    deps.confirmQuit().catch((err) => {
      console.warn('Quit failed:', err);
      setSessions(null);
    });
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="quit-confirm-title"
        data-testid="quit-confirm"
        className="w-80 rounded-lg border border-gray-700 bg-gray-800 p-5 shadow-2xl"
      >
        <h2 id="quit-confirm-title" className="mb-2 text-sm font-semibold text-white">Quit Breeze Viewer?</h2>
        <p className="mb-4 text-xs text-gray-300">
          This ends {sessions} remote {sessions === 1 ? 'session' : 'sessions'}.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            data-testid="quit-confirm-cancel"
            onClick={() => setSessions(null)}
            className="rounded bg-gray-700 px-3 py-1.5 text-xs text-white hover:bg-gray-600"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="quit-confirm-quit"
            onClick={quit}
            className="rounded bg-red-700 px-3 py-1.5 text-xs text-white hover:bg-red-600"
          >
            Quit
          </button>
        </div>
      </div>
    </div>
  );
}
