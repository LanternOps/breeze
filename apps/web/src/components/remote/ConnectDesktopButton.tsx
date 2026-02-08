import { useState, useCallback, useRef, useEffect } from 'react';
import { Monitor, ExternalLink, Download } from 'lucide-react';
import { fetchWithAuth, useAuthStore } from '@/stores/auth';

interface Props {
  deviceId: string;
  className?: string;
  compact?: boolean;
}

export default function ConnectDesktopButton({ deviceId, className = '', compact = false }: Props) {
  const [status, setStatus] = useState<'idle' | 'creating' | 'launching' | 'fallback'>('idle');
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Clean up listeners on unmount
  useEffect(() => {
    return () => { cleanupRef.current?.(); };
  }, []);

  const handleConnect = useCallback(async () => {
    setStatus('creating');
    setError(null);

    try {
      // Create desktop session
      const response = await fetchWithAuth('/remote/sessions', {
        method: 'POST',
        body: JSON.stringify({
          deviceId,
          type: 'desktop',
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to create desktop session');
      }

      const session = await response.json();

      // Get access token
      const { tokens } = useAuthStore.getState();
      if (!tokens?.accessToken) {
        throw new Error('Not authenticated');
      }

      // Build deep link URL
      const apiUrl = import.meta.env.PUBLIC_API_URL || 'http://localhost:3001';
      const deepLink = `breeze://connect?session=${encodeURIComponent(session.id)}&token=${encodeURIComponent(tokens.accessToken)}&api=${encodeURIComponent(apiUrl)}`;

      setStatus('launching');

      // Trigger the OS protocol handler. For custom protocols like breeze://,
      // the browser hands the URL off to the OS and stays on the current page.
      window.location.href = deepLink;

      // Detect if the app launched by listening for window blur (the OS steals
      // focus when it opens the Breeze Viewer app).
      let launched = false;
      let fallbackTimer: ReturnType<typeof setTimeout>;

      const onBlur = () => {
        launched = true;
        setStatus('idle');
      };

      const cleanup = () => {
        window.removeEventListener('blur', onBlur);
        clearTimeout(fallbackTimer);
        cleanupRef.current = null;
      };

      window.addEventListener('blur', onBlur);
      cleanupRef.current = cleanup;

      // Show fallback after 4 seconds if the app didn't launch
      fallbackTimer = setTimeout(() => {
        cleanup();
        if (!launched) {
          // End the session we created so it doesn't count against the limit
          fetchWithAuth(`/remote/sessions/${session.id}/end`, { method: 'POST' }).catch(() => {});
          setStatus((current) => current === 'launching' ? 'fallback' : current);
        }
      }, 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      setStatus('idle');
    }
  }, [deviceId]);

  if (compact) {
    return (
      <button
        type="button"
        onClick={handleConnect}
        disabled={status === 'creating' || status === 'launching'}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Monitor className="h-4 w-4" />
        {status === 'creating' ? 'Connecting...' :
         status === 'launching' ? 'Launching...' :
         'Connect Desktop'}
      </button>
    );
  }

  return (
    <div className={`relative ${className}`}>
      <button
        onClick={handleConnect}
        disabled={status === 'creating' || status === 'launching'}
        className="flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Monitor className="h-4 w-4" />
        {status === 'creating' ? 'Creating session...' :
         status === 'launching' ? 'Launching viewer...' :
         'Connect Desktop'}
        {status === 'idle' && <ExternalLink className="w-3.5 h-3.5 opacity-60" />}
      </button>

      {error && (
        <p className="absolute left-0 top-full mt-2 text-sm text-red-500 dark:text-red-400">{error}</p>
      )}

      {status === 'fallback' && (
        <div className="absolute left-0 top-full z-50 mt-2 w-72 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm shadow-lg dark:border-amber-800 dark:bg-amber-950">
          <div className="flex items-start gap-2.5">
            <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="flex-1">
              <p className="font-medium text-amber-800 dark:text-amber-300">
                Breeze Viewer not installed
              </p>
              <div className="mt-2.5 flex items-center gap-3">
                <a
                  href="#"
                  className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download
                </a>
                <button
                  onClick={() => setStatus('idle')}
                  className="text-xs text-muted-foreground transition hover:text-foreground"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
