import { useEffect, useState, useCallback, useRef } from 'react';
import { Monitor } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import DesktopViewer from './components/DesktopViewer';
import UpdateIndicator from './components/UpdateIndicator';
import { parseDeepLink, type ConnectionParams } from './lib/protocol';

/**
 * Main window: hidden, serves as process anchor (Tauri requires at least one window).
 * Session windows: connect via deep link, show DesktopViewer.
 */
export default function App() {
  const [windowLabel, setWindowLabel] = useState<string>('main');
  const [params, setParams] = useState<ConnectionParams | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastDeepLinkRef = useRef<{ key: string; at: number } | null>(null);

  // Detect window role on mount
  useEffect(() => {
    try {
      const win = getCurrentWebviewWindow();
      setWindowLabel(win.label);
    } catch {
      // fallback: main
    }
  }, []);

  // ── Session window: deep link polling + events ─────────────────────
  const applyDeepLink = useCallback((url: string) => {
    const parsed = parseDeepLink(url);
    if (!parsed) return;

    const key = parsed.mode === 'desktop'
      ? `${parsed.sessionId}|${parsed.connectCode}|${parsed.apiUrl}`
      : `${parsed.tunnelId}|${parsed.code}|${parsed.apiUrl}`;
    const now = Date.now();
    const last = lastDeepLinkRef.current;
    if (last && last.key === key && now - last.at < 2000) return;

    lastDeepLinkRef.current = { key, at: now };
    invoke('clear_pending_deep_link').catch(() => {});
    setParams(parsed);
    setError(null);
  }, []);

  useEffect(() => {
    if (windowLabel === 'main') return;

    // Path 1: Poll Rust for pending deep link
    let pollCount = 0;
    const maxPolls = 17;
    const pollTimer = setInterval(() => {
      pollCount++;
      invoke<string | null>('get_pending_deep_link').then((url) => {
        if (url) {
          clearInterval(pollTimer);
          applyDeepLink(url);
        } else if (pollCount >= maxPolls) {
          clearInterval(pollTimer);
        }
      }).catch(() => {
        if (pollCount >= maxPolls) clearInterval(pollTimer);
      });
    }, 300);

    // Path 2: Listen for events scoped to THIS window only.
    // Global listen() receives events from all windows — emit_to("session-2")
    // would also trigger session-1's listener, causing cross-window bleed.
    const unlisten = getCurrentWebviewWindow().listen<string>('deep-link-received', (event) => {
      applyDeepLink(event.payload);
    });

    return () => {
      clearInterval(pollTimer);
      unlisten.then((fn) => fn());
    };
  }, [windowLabel, applyDeepLink]);

  const handleDisconnect = useCallback(() => {
    lastDeepLinkRef.current = null;
    getCurrentWebviewWindow().close().catch(() => {
      // If Tauri close fails, clear state to unmount the viewer
      setParams(null);
    });
  }, []);

  const handleError = useCallback((msg: string) => {
    lastDeepLinkRef.current = null;
    setError(msg);
  }, []);

  // ── Main window: idle card ──────────────────────────────────────────
  // Normally hidden (it is just the process anchor), but Rust shows it when the
  // viewer is launched by hand with no deep link. On Linux that is the required
  // first run — the AppImage has to be executed once to register itself as the
  // `breeze://` handler — so this window is the only confirmation the user gets
  // that the install worked (#2614).
  if (windowLabel === 'main') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-gray-900 px-8 text-center">
        <Monitor className="h-8 w-8 text-accent-soft" />
        <h1 className="text-base font-semibold text-white">Breeze Viewer is ready</h1>
        <p className="text-sm leading-relaxed text-gray-400">
          Remote sessions open automatically when you choose{' '}
          <span className="font-medium text-gray-200">Connect Desktop</span> in the Breeze console.
        </p>
        <p className="text-xs text-gray-500">
          You can close this window — Breeze reopens the viewer when a session starts.
        </p>
      </div>
    );
  }

  // ── Session window: viewer ─────────────────────────────────────────
  // UpdateIndicator overlays every session-window state so an in-progress
  // auto-update is visible whether connected or still connecting (the
  // updater fires ~3s after launch, often during connection setup).
  if (params) {
    return (
      <>
        <UpdateIndicator />
        <DesktopViewer
          params={params}
          onDisconnect={handleDisconnect}
          onError={handleError}
        />
      </>
    );
  }

  // Waiting for deep link
  return (
    <>
      <UpdateIndicator />
      <div className="flex items-center justify-center h-screen bg-gray-900">
        <div className="text-center">
          <div className="w-6 h-6 border-2 border-accent-soft border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-gray-400 text-sm">Connecting…</p>
          {error && (
            <p className="text-danger text-sm mt-2">{error}</p>
          )}
        </div>
      </div>
    </>
  );
}
