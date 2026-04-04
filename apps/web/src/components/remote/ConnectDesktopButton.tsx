import { useState, useCallback, useRef, useEffect } from 'react';
import { Monitor, MonitorOff, ExternalLink, Download, X } from 'lucide-react';
import type { DesktopAccessState, RemoteAccessPolicy } from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';
import { getViewerDownloadInfo, getAllViewerDownloads } from '@/lib/viewerDownload';

interface Props {
  deviceId: string;
  className?: string;
  compact?: boolean;
  iconOnly?: boolean;
  disabled?: boolean;
  isHeadless?: boolean;
  desktopAccess?: DesktopAccessState | null;
  remoteAccessPolicy?: RemoteAccessPolicy | null;
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

function desktopAccessUnavailableReason(desktopAccess: DesktopAccessState | null | undefined): string | null {
  if (!desktopAccess || desktopAccess.mode !== 'unavailable') {
    return null;
  }

  switch (desktopAccess.reason) {
    case 'unsupported_os':
      return 'Login-window desktop requires macOS 14 (Sonoma) or later. User-session remote desktop is still available when a user is logged in.';
    case 'missing_entitlement':
      return 'Login-window desktop is blocked until the required Apple entitlement is approved';
    case 'manual_install':
      return 'Login-window desktop is only supported for managed installs';
    case 'missing_permission':
      return 'macOS permissions required for unattended desktop access are still missing';
    case 'virtual_display_unavailable':
      return 'No capturable display is available for this Mac';
    case 'helper_not_connected':
      return 'The macOS desktop helper is not connected yet';
    default:
      return 'Desktop is unavailable on this device';
  }
}

export default function ConnectDesktopButton({ deviceId, className = '', compact = false, iconOnly = false, disabled = false, isHeadless = false, desktopAccess = null, remoteAccessPolicy = null }: Props) {
  const [status, setStatus] = useState<'idle' | 'creating' | 'launching' | 'fallback'>('idle');
  const [error, setError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoDismissTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sessionIdRef = useRef<string | null>(null);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (autoDismissTimerRef.current) clearTimeout(autoDismissTimerRef.current);
    };
  }, []);

  const endSession = useCallback((sessionId: string) => {
    fetchWithAuth(`/remote/sessions/${sessionId}/end`, { method: 'POST' }).catch(() => {});
  }, []);

  const handleConnect = useCallback(async () => {
    setStatus('creating');
    setError(null);

    try {
      // Clean up stale sessions in parallel with creating new one
      const [, response] = await Promise.all([
        fetchWithAuth('/remote/sessions/stale', { method: 'DELETE' }).catch(() => {}),
        fetchWithAuth('/remote/sessions', {
          method: 'POST',
          body: JSON.stringify({
            deviceId,
            type: 'desktop',
          }),
        }),
      ]);

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

      // Poll session status to detect whether the viewer actually opened.
      // The session starts as 'pending'; the viewer exchanges the connect code
      // almost immediately, moving it to 'connecting' then 'active'.
      // If it stays 'pending' after ~8s the viewer likely didn't launch.
      const pollSessionId = session.id;
      let pollCount = 0;
      const maxPolls = 5; // 5 polls × ~1.5s = ~7.5s window

      const poll = async () => {
        pollCount++;
        try {
          const res = await fetchWithAuth(`/remote/sessions/${pollSessionId}`);
          if (res.ok) {
            const data = await res.json();
            const sessionStatus = data.status ?? data.data?.status;
            if (sessionStatus && sessionStatus !== 'pending') {
              // Viewer connected — silently go back to idle
              setStatus((cur) => cur === 'launching' || cur === 'fallback' ? 'idle' : cur);
              return;
            }
          }
        } catch { /* network error — keep polling */ }

        if (pollCount >= maxPolls) {
          // Timed out still pending — viewer didn't open, show fallback
          setStatus((cur) => cur === 'launching' ? 'fallback' : cur);

          // Auto-dismiss fallback after 20s so it doesn't linger
          if (autoDismissTimerRef.current) clearTimeout(autoDismissTimerRef.current);
          autoDismissTimerRef.current = setTimeout(() => {
            setStatus((cur) => cur === 'fallback' ? 'idle' : cur);
          }, 20000);
          return;
        }

        pollTimerRef.current = setTimeout(poll, 1500);
      };

      pollTimerRef.current = setTimeout(poll, 1500);
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
    <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm shadow-lg dark:border-amber-800 dark:bg-amber-950">
      <div className="flex items-start gap-2.5">
        <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="flex-1">
          <p className="font-medium text-amber-800 dark:text-amber-300">
            Viewer didn't open?
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

  const headlessTitle = 'This device has no display \u2014 remote desktop is unavailable';
  const desktopAccessUnavailable = desktopAccessUnavailableReason(desktopAccess);
  const policyDisabled = remoteAccessPolicy?.webrtcDesktop === false;
  const policyTitle = policyDisabled
    ? `Remote desktop is disabled by policy${remoteAccessPolicy?.policyName ? ` "${remoteAccessPolicy.policyName}"` : ''}`
    : null;
  const unavailableTitle = policyTitle ?? desktopAccessUnavailable ?? headlessTitle;

  if (policyDisabled || isHeadless || desktopAccessUnavailable) {
    if (iconOnly) {
      return (
        <div className={`relative ${className}`}>
          <button
            type="button"
            disabled
            title={unavailableTitle}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground cursor-not-allowed opacity-50"
          >
            <MonitorOff className="h-4 w-4" />
          </button>
        </div>
      );
    }

    if (compact) {
      return (
        <div className="relative">
          <button
            type="button"
            disabled
            title={unavailableTitle}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-muted-foreground cursor-not-allowed opacity-50"
          >
            <MonitorOff className="h-4 w-4" />
            Desktop Unavailable
          </button>
        </div>
      );
    }

    return (
      <div className={`relative ${className}`}>
        <button
          type="button"
          disabled
          title={unavailableTitle}
          className="flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground cursor-not-allowed opacity-50"
        >
          <MonitorOff className="h-4 w-4" />
          Desktop Unavailable
        </button>
      </div>
    );
  }

  if (iconOnly) {
    return (
      <div className={`relative ${className}`}>
        <button
          type="button"
          onClick={handleConnect}
          disabled={disabled || status === 'creating' || status === 'launching'}
          title={error || 'Connect Desktop'}
          className={`flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 ${error ? 'text-red-500' : ''}`}
        >
          {status === 'creating' || status === 'launching' ? (
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          ) : (
            <Monitor className="h-4 w-4" />
          )}
        </button>
        {fallbackContent}
      </div>
    );
  }

  if (compact) {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={handleConnect}
          disabled={status === 'creating' || status === 'launching'}
          title={error || undefined}
          className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 ${error ? 'text-red-500' : ''}`}
        >
          <Monitor className="h-4 w-4" />
          {error ? 'Connection failed' :
           status === 'creating' ? 'Connecting...' :
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
        title={error || undefined}
        className={`flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${error ? 'border-red-300 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-800 dark:bg-red-950 dark:text-red-400 dark:hover:bg-red-900' : 'bg-background hover:bg-muted'}`}
      >
        <Monitor className="h-4 w-4" />
        {error ? 'Connection failed' :
         status === 'creating' ? 'Creating session...' :
         status === 'launching' ? 'Launching viewer...' :
         'Connect Desktop'}
        {status === 'idle' && !error && <ExternalLink className="w-3.5 h-3.5 opacity-60" />}
      </button>

      {fallbackContent}
    </div>
  );
}
