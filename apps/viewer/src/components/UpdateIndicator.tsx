import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Download, RefreshCw, CheckCircle2 } from 'lucide-react';
import {
  updateStatusMessage,
  updateProgressPercent,
  isUpdateActive,
  shouldAutoDismiss,
  type UpdateStatus,
} from '../lib/updateStatus';

/** How long a deferred-update notice lingers before auto-dismissing (ms). */
const DEFERRED_DISMISS_MS = 10_000;

/**
 * Small fixed banner that surfaces the otherwise-silent auto-updater.
 *
 * The Rust updater (`src-tauri/src/lib.rs` `auto_update`) downloads and
 * installs in the background, then the window vanishes (Windows installer)
 * or the app restarts (macOS/Linux). Without this banner that looks like a
 * crash. We listen for the broadcast `update-status` event and show what's
 * actually happening.
 */
export default function UpdateIndicator() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    const unlisten = listen<UpdateStatus>('update-status', (event) => {
      setStatus(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  // Auto-dismiss informational (deferred) notices; in-flight phases stay
  // pinned until the process exits or restarts.
  useEffect(() => {
    if (!status || !shouldAutoDismiss(status)) return;
    const timer = setTimeout(() => setStatus(null), DEFERRED_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [status]);

  if (!status) return null;

  const message = updateStatusMessage(status);
  const percent = updateProgressPercent(status);
  const active = isUpdateActive(status);

  const Icon =
    status.phase === 'deferred'
      ? CheckCircle2
      : status.phase === 'restarting'
        ? RefreshCw
        : Download;

  return (
    <div
      data-testid="update-indicator"
      role="status"
      aria-live="polite"
      className="fixed top-3 left-1/2 -translate-x-1/2 z-50 max-w-[90vw]
                 flex flex-col gap-1 px-3 py-2 rounded-lg shadow-lg
                 bg-gray-800/95 border border-gray-700 text-gray-100
                 backdrop-blur-sm pointer-events-none"
    >
      <div className="flex items-center gap-2 text-xs">
        <Icon
          className={`w-3.5 h-3.5 text-blue-400 ${status.phase === 'restarting' ? 'animate-spin' : ''}`}
        />
        <span className="whitespace-nowrap">{message}</span>
      </div>
      {active && (
        <div className="h-1 w-full rounded bg-gray-700 overflow-hidden">
          {percent == null ? (
            // Indeterminate: animated pulse when total size is unknown.
            <div className="h-full w-full bg-blue-500 animate-pulse" />
          ) : (
            <div
              data-testid="update-progress-bar"
              className="h-full bg-blue-500 transition-[width] duration-200"
              style={{ width: `${percent}%` }}
            />
          )}
        </div>
      )}
    </div>
  );
}
