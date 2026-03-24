import { useEffect, useState, useCallback, useRef } from 'react';
import type { ComponentType } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import DesktopViewer from './components/DesktopViewer';
import { parseDeepLink, type ConnectionParams } from './lib/protocol';
import { checkForUpdate, type UpdateInfo } from './lib/version';
import { ArrowDownCircle, AlertTriangle } from 'lucide-react';

const UpdateIcon = ArrowDownCircle as unknown as ComponentType<{ className?: string }>;
const AlertIcon = AlertTriangle as unknown as ComponentType<{ className?: string }>;

type UpdateStatus = 'checking' | 'current' | 'outdated' | 'error';

/**
 * Main window: runs update check, stays hidden unless outdated.
 * Session windows: connect via deep link, show DesktopViewer.
 */
export default function App() {
  const [windowLabel, setWindowLabel] = useState<string>('main');
  const [params, setParams] = useState<ConnectionParams | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('checking');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
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

  // ── Main window: update check ──────────────────────────────────────
  useEffect(() => {
    if (windowLabel !== 'main') return;

    checkForUpdate().then((info) => {
      if (info) {
        setUpdateInfo(info);
        setUpdateStatus('outdated');
        // Show the main window so the user sees the update prompt
        try { getCurrentWebviewWindow().show(); } catch {}
      } else {
        setUpdateStatus('current');
        // Signal Rust that it's safe to create session windows
        invoke('set_update_ok').catch(() => {});
      }
    }).catch(() => {
      // Can't reach GitHub — allow usage rather than bricking offline
      setUpdateStatus('error');
      invoke('set_update_ok').catch(() => {});
    });
  }, [windowLabel]);

  // ── Session window: deep link polling + events ─────────────────────
  const applyDeepLink = useCallback((url: string) => {
    const parsed = parseDeepLink(url);
    if (!parsed) return;

    const key = `${parsed.sessionId}|${parsed.connectCode}|${parsed.apiUrl}`;
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

    // Path 2: Listen for events
    const unlisten = listen<string>('deep-link-received', (event) => {
      applyDeepLink(event.payload);
    });

    return () => {
      clearInterval(pollTimer);
      unlisten.then((fn) => fn());
    };
  }, [windowLabel, applyDeepLink]);

  const handleDisconnect = useCallback(() => {
    lastDeepLinkRef.current = null;
    try {
      getCurrentWebviewWindow().close();
    } catch {
      // If close fails, at least clear state
      setParams(null);
    }
  }, []);

  const handleError = useCallback((msg: string) => {
    lastDeepLinkRef.current = null;
    setError(msg);
  }, []);

  const handleOpenDownload = useCallback(async () => {
    const url = updateInfo?.downloadUrl || updateInfo?.releaseUrl;
    if (!url) return;
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
    } catch {
      window.open(url, '_blank');
    }
    try {
      getCurrentWebviewWindow().close();
    } catch {
      // best-effort
    }
  }, [updateInfo]);

  // ── Main window renders ────────────────────────────────────────────
  if (windowLabel === 'main') {
    // Outdated: show update prompt (window was made visible above)
    if (updateStatus === 'outdated' && updateInfo) {
      return (
        <div className="flex items-center justify-center h-screen bg-gray-900">
          <div className="text-center max-w-md px-6">
            <div className="flex items-center justify-center w-16 h-16 bg-amber-600/20 rounded-2xl mx-auto mb-6">
              <AlertIcon className="w-8 h-8 text-amber-400" />
            </div>
            <h1 className="text-2xl font-semibold text-white mb-2">Update Required</h1>
            <p className="text-gray-400 mb-2">
              A new version of Breeze Viewer is available. Please update to continue.
            </p>
            <div className="mb-8 p-3 bg-gray-800/50 rounded-lg">
              <p className="text-gray-300 text-sm">
                Installed: <span className="font-mono text-amber-400">v{updateInfo.currentVersion}</span>
                <span className="mx-2 text-gray-600">&rarr;</span>
                Latest: <span className="font-mono text-green-400">v{updateInfo.latestVersion}</span>
              </p>
            </div>
            <button
              onClick={handleOpenDownload}
              className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg text-white font-medium transition"
            >
              <UpdateIcon className="w-5 h-5" />
              Download Update
            </button>
            <p className="text-gray-600 text-xs mt-4">
              Install the update and relaunch the viewer.
            </p>
          </div>
        </div>
      );
    }
    // Hidden — render nothing (checking or current)
    return null;
  }

  // ── Session window renders ─────────────────────────────────────────
  if (params) {
    return (
      <DesktopViewer
        params={params}
        onDisconnect={handleDisconnect}
        onError={handleError}
      />
    );
  }

  // Waiting for deep link
  return (
    <div className="flex items-center justify-center h-screen bg-gray-900">
      <div className="text-center">
        <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-gray-400 text-sm">Connecting...</p>
        {error && (
          <p className="text-red-400 text-sm mt-2">{error}</p>
        )}
      </div>
    </div>
  );
}
