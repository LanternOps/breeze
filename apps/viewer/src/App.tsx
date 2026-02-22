import { useEffect, useState, useCallback, useRef } from 'react';
import type { ComponentType } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import DesktopViewer from './components/DesktopViewer';
import { parseDeepLink, type ConnectionParams } from './lib/protocol';
import { checkForUpdate, type UpdateInfo } from './lib/version';
import { Monitor, ArrowDownCircle, AlertTriangle } from 'lucide-react';

const MonitorIcon = Monitor as unknown as ComponentType<{ className?: string }>;
const UpdateIcon = ArrowDownCircle as unknown as ComponentType<{ className?: string }>;
const AlertIcon = AlertTriangle as unknown as ComponentType<{ className?: string }>;

type UpdateStatus = 'checking' | 'current' | 'outdated' | 'error';

export default function App() {
  const [params, setParams] = useState<ConnectionParams | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState('');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('checking');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const lastDeepLinkRef = useRef<{ key: string; at: number } | null>(null);
  const windowLabelRef = useRef<string>('main');

  // Get the window label on mount
  useEffect(() => {
    try {
      const win = getCurrentWebviewWindow();
      windowLabelRef.current = win.label;
    } catch {
      // fallback: main
    }
  }, []);

  // Check for updates on mount — blocks the app if outdated
  useEffect(() => {
    checkForUpdate().then((info) => {
      if (info) {
        setUpdateInfo(info);
        setUpdateStatus('outdated');
      } else {
        setUpdateStatus('current');
      }
    }).catch(() => {
      // Can't reach GitHub — allow usage rather than bricking offline
      setUpdateStatus('error');
    });
  }, []);

  // Apply a parsed deep link, deduplicating burst delivery
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
    // Path 1: Poll the Rust backend for a pending deep link URL.
    let pollCount = 0;
    const maxPolls = 17; // ~5 seconds
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

    // Path 2: Listen for deep-link-received events
    const unlisten = listen<string>('deep-link-received', (event) => {
      applyDeepLink(event.payload);
    });

    return () => {
      clearInterval(pollTimer);
      unlisten.then((fn) => fn());
    };
  }, [applyDeepLink]);

  const handleDisconnect = useCallback(() => {
    lastDeepLinkRef.current = null;

    // If this is a secondary window, close it instead of returning to welcome screen
    const label = windowLabelRef.current;
    if (label !== 'main') {
      try {
        getCurrentWebviewWindow().close();
      } catch (err) {
        console.warn('Failed to close secondary window:', err);
        setParams(null);
        setError(null);
      }
      return;
    }

    setParams(null);
    setError(null);
  }, []);

  const handleError = useCallback((msg: string) => {
    lastDeepLinkRef.current = null;
    setError(msg);
  }, []);

  const handleManualConnect = useCallback(() => {
    const parsed = parseDeepLink(manualUrl);
    if (parsed) {
      lastDeepLinkRef.current = {
        key: `${parsed.sessionId}|${parsed.connectCode}|${parsed.apiUrl}`,
        at: Date.now(),
      };
      setParams(parsed);
      setError(null);
    } else {
      setError('Invalid connection URL. Expected: breeze://connect?session=...&code=...&api=... (api must be https, or http://localhost for dev).');
    }
  }, [manualUrl]);

  const handleOpenDownload = useCallback(async () => {
    const url = updateInfo?.downloadUrl || updateInfo?.releaseUrl;
    if (!url) return;
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
    } catch {
      window.open(url, '_blank');
    }
  }, [updateInfo]);

  // Forced update gate — blocks everything when outdated
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

  // Show a brief loading screen while checking for updates
  if (updateStatus === 'checking') {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900">
        <div className="text-center">
          <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-gray-400 text-sm">Checking for updates...</p>
        </div>
      </div>
    );
  }

  // Show viewer if connected
  if (params) {
    return (
      <DesktopViewer
        params={params}
        onDisconnect={handleDisconnect}
        onError={handleError}
      />
    );
  }

  // Welcome / waiting screen
  return (
    <div className="flex items-center justify-center h-screen bg-gray-900">
      <div className="text-center max-w-md px-6">
        <div className="flex items-center justify-center w-16 h-16 bg-blue-600/20 rounded-2xl mx-auto mb-6">
          <MonitorIcon className="w-8 h-8 text-blue-400" />
        </div>
        <h1 className="text-2xl font-semibold text-white mb-2">Breeze Remote Desktop</h1>
        <p className="text-gray-400 mb-8">
          Launch a remote desktop session from the Breeze web console, or paste a connection URL below.
        </p>

        {error && (
          <div className="mb-6 p-3 bg-red-900/30 border border-red-800 rounded-lg text-red-300 text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            placeholder="breeze://connect?session=...&code=...&api=..."
            className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
            onKeyDown={(e) => e.key === 'Enter' && handleManualConnect()}
          />
          <button
            onClick={handleManualConnect}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm text-white font-medium"
          >
            Connect
          </button>
        </div>

        <p className="text-gray-600 text-xs">
          Waiting for connection via <code className="text-gray-500">breeze://</code> deep link...
        </p>
      </div>
    </div>
  );
}
