import { useState, useCallback, useRef, useEffect } from 'react';
import { Monitor, ExternalLink, Download, X } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';
import { getViewerDownloadInfo, getAllViewerDownloads } from '@/lib/viewerDownload';

interface Props {
  deviceId: string;
  className?: string;
  compact?: boolean;
}

/**
 * Launch a custom-protocol deep link. Uses an anchor click so the browser
 * hands the URL to the OS protocol handler without navigating the page.
 */
function tryDeepLink(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 100);
}

export default function ConnectDesktopButton({ deviceId, className = '', compact = false }: Props) {
  const [status, setStatus] = useState<'idle' | 'creating' | 'launching' | 'fallback'>('idle');
  const [error, setError] = useState<string | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sessionIdRef = useRef<string | null>(null);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
    };
  }, []);

  const endSession = useCallback((sessionId: string) => {
    fetchWithAuth(`/remote/sessions/${sessionId}/end`, { method: 'POST' }).catch(() => {});
  }, []);

  const handleConnect = useCallback(async () => {
    setStatus('creating');
    setError(null);

    try {
      // Clean up any stale sessions for this user before creating a new one
      await fetchWithAuth('/remote/sessions/stale', { method: 'DELETE' }).catch(() => {});

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
      sessionIdRef.current = session.id;

      // Create one-time desktop connect code for deep-link handoff
      const codeResponse = await fetchWithAuth(`/remote/sessions/${session.id}/desktop-connect-code`, {
        method: 'POST',
      });
      if (!codeResponse.ok) {
        const err = await codeResponse.json().catch(() => ({ error: 'Failed to create desktop connect code' }));
        endSession(session.id);
        throw new Error(err.error || 'Failed to create desktop connect code');
      }
      const codeData = await codeResponse.json() as { code?: string };
      if (!codeData.code) {
        endSession(session.id);
        throw new Error('Invalid desktop connect code response');
      }

      // Build deep link URL
      const apiUrl = import.meta.env.PUBLIC_API_URL || window.location.origin;
      const deepLink = `breeze://connect?session=${encodeURIComponent(session.id)}&code=${encodeURIComponent(codeData.code)}&api=${encodeURIComponent(apiUrl)}`;

      setStatus('launching');

      // Use hidden iframe to trigger protocol handler without affecting the page
      tryDeepLink(deepLink);

      // Always show fallback after 3 seconds — if the viewer opened, the user
      // simply ignores it; if it didn't, they get the download link immediately.
      fallbackTimerRef.current = setTimeout(() => {
        setStatus((current) => current === 'launching' ? 'fallback' : current);
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      setStatus('idle');
    }
  }, [deviceId, endSession]);

  const handleDismiss = useCallback(() => {
    setStatus('idle');
  }, []);

  const handleDismissAndCleanup = useCallback(() => {
    // End the session since the viewer didn't open
    if (sessionIdRef.current) {
      endSession(sessionIdRef.current);
      sessionIdRef.current = null;
    }
    setStatus('idle');
  }, [endSession]);

  // Shared fallback content for both compact and full modes
  const fallbackContent = status === 'fallback' ? (
    <div className="absolute left-0 top-full z-50 mt-2 w-72 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm shadow-lg dark:border-amber-800 dark:bg-amber-950">
      <div className="flex items-start gap-2.5">
        <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="flex-1">
          <p className="font-medium text-amber-800 dark:text-amber-300">
            Breeze Viewer not detected
          </p>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            If the viewer opened, you can dismiss this. Otherwise, download it below.
          </p>
          {(() => {
            const downloadInfo = getViewerDownloadInfo();
            if (downloadInfo) {
              return (
                <div className="mt-2.5 flex items-center gap-3">
                  <a
                    href={downloadInfo.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => handleDismissAndCleanup()}
                    className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download for {downloadInfo.label}
                  </a>
                  <button
                    type="button"
                    onClick={handleDismiss}
                    className="text-xs text-muted-foreground transition hover:text-foreground"
                  >
                    Dismiss
                  </button>
                </div>
              );
            }
            return (
              <div className="mt-2.5 space-y-2">
                <div className="flex flex-col gap-1.5">
                  {getAllViewerDownloads().map((dl) => (
                    <a
                      key={dl.os}
                      href={dl.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => handleDismissAndCleanup()}
                      className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700"
                    >
                      <Download className="h-3.5 w-3.5" />
                      {dl.label}
                    </a>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={handleDismiss}
                  className="text-xs text-muted-foreground transition hover:text-foreground"
                >
                  Dismiss
                </button>
              </div>
            );
          })()}
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="flex h-5 w-5 items-center justify-center rounded hover:bg-amber-200 dark:hover:bg-amber-800"
        >
          <X className="h-3 w-3 text-amber-600 dark:text-amber-400" />
        </button>
      </div>
    </div>
  ) : null;

  if (compact) {
    return (
      <div className="relative">
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
        {fallbackContent}
      </div>
    );
  }

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
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

      {fallbackContent}
    </div>
  );
}
