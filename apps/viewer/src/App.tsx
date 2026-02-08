import { useEffect, useState, useCallback, useRef } from 'react';
import type { ComponentType } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import DesktopViewer from './components/DesktopViewer';
import { parseDeepLink, type ConnectionParams } from './lib/protocol';
import { Monitor } from 'lucide-react';

const MonitorIcon = Monitor as unknown as ComponentType<{ className?: string }>;

export default function App() {
  const [params, setParams] = useState<ConnectionParams | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState('');
  const lastSessionRef = useRef<string | null>(null);

  // Apply a parsed deep link, deduplicating by session ID
  const applyDeepLink = useCallback((url: string) => {
    const parsed = parseDeepLink(url);
    if (parsed && parsed.sessionId !== lastSessionRef.current) {
      lastSessionRef.current = parsed.sessionId;
      setParams(parsed);
      setError(null);
    }
  }, []);

  useEffect(() => {
    // Path 1: Ask the Rust backend for the deep link that launched the app.
    // On macOS this may return null due to async URL delivery timing.
    invoke<string | null>('get_initial_deep_link').then((url) => {
      if (url) applyDeepLink(url);
    });

    // Path 2: Listen for deep-link-received events. This fires when:
    // - The Rust backend emits the initial URL after a short delay (macOS race fix)
    // - The app is already running and a new deep link is triggered (on_open_url)
    // - On Linux/Windows, the single-instance plugin forwards the URL from argv
    const unlisten = listen<string>('deep-link-received', (event) => {
      applyDeepLink(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [applyDeepLink]);

  const handleDisconnect = useCallback(() => {
    lastSessionRef.current = null;
    setParams(null);
    setError(null);
  }, []);

  const handleError = useCallback((msg: string) => {
    setError(msg);
  }, []);

  const handleManualConnect = useCallback(() => {
    const parsed = parseDeepLink(manualUrl);
    if (parsed) {
      lastSessionRef.current = parsed.sessionId;
      setParams(parsed);
      setError(null);
    } else {
      setError('Invalid connection URL. Expected format: breeze://connect?session=...&token=...&api=...');
    }
  }, [manualUrl]);

  // Show viewer if connected
  if (params && !error) {
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
            placeholder="breeze://connect?session=...&token=...&api=..."
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
