import { useState, useCallback, useRef, useEffect } from 'react';
import { Monitor, MonitorOff, ExternalLink, Download, X, Globe } from 'lucide-react';
import type { DesktopAccessState, RemoteAccessPolicy } from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';
import { getViewerDownloadInfo, getAllViewerDownloads } from '@/lib/viewerDownload';
import { buildRemoteVncPageUrl } from '@/lib/remoteTunnelUrls';

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

// Reasons where VNC relay is a viable fallback (when the user has enabled VNC Relay policy).
// These are cases where WebRTC desktop can't work but the native macOS Screen Sharing
// path via kickstart can still connect (login window, legacy OS, helper stuck, etc).
const VNC_FALLBACK_REASONS = new Set([
  'unsupported_os',
  'helper_not_connected',
  'virtual_display_unavailable',
]);

function canFallbackToVNC(
  desktopAccess: DesktopAccessState | null | undefined,
  remoteAccessPolicy?: RemoteAccessPolicy | null,
): boolean {
  if (!desktopAccess || desktopAccess.mode !== 'unavailable') return false;
  if (remoteAccessPolicy?.vncRelay !== true) return false;
  return VNC_FALLBACK_REASONS.has(desktopAccess.reason ?? '');
}

function desktopAccessUnavailableReason(
  desktopAccess: DesktopAccessState | null | undefined,
  remoteAccessPolicy?: RemoteAccessPolicy | null,
): string | null {
  if (!desktopAccess || desktopAccess.mode !== 'unavailable') {
    return null;
  }

  // VNC fallback masks the unavailable reason — user can click through to VNC.
  if (canFallbackToVNC(desktopAccess, remoteAccessPolicy)) {
    return null;
  }

  switch (desktopAccess.reason) {
    case 'unsupported_os':
      return 'Login-window desktop requires macOS 14 (Sonoma) or later. Enable VNC Relay in the device\'s configuration policy to connect at the login screen.';
    case 'missing_entitlement':
      return 'Login-window desktop is blocked until the required Apple entitlement is approved';
    case 'manual_install':
      return 'Login-window desktop is only supported for managed installs';
    case 'missing_permission':
      return 'macOS permissions required for unattended desktop access are still missing';
    case 'virtual_display_unavailable':
      return 'No capturable display is available for this Mac. Enable VNC Relay to connect via macOS Screen Sharing.';
    case 'helper_not_connected':
      return 'The macOS desktop helper is not connected yet. Enable VNC Relay to connect via macOS Screen Sharing.';
    default:
      return 'Desktop is unavailable on this device';
  }
}

export default function ConnectDesktopButton({ deviceId, className = '', compact = false, iconOnly = false, disabled = false, isHeadless = false, desktopAccess = null, remoteAccessPolicy = null }: Props) {
  const [status, setStatus] = useState<'idle' | 'creating' | 'launching' | 'fallback'>('idle');
  const [error, setError] = useState<string | null>(null);
  // Populated when the VNC auto-fallback path times out — carries the info needed
  // for the "Open in Browser" fallback card so we don't navigate away automatically.
  const [vncFallback, setVncFallback] = useState<{ tunnelId: string } | null>(null);
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
      // The `desktopAccess` prop is fetched once when the Remote Tools page mounts
      // and never refreshed. On a slow helper-attach or after the user logs in
      // on the Mac, the snapshot goes stale and we'd route to VNC even when
      // WebRTC is now available. Re-fetch the device record right before
      // deciding so the click always uses fresh state.
      let liveDesktopAccess: DesktopAccessState | null = desktopAccess ?? null;
      try {
        const devRes = await fetchWithAuth(`/devices/${deviceId}`);
        if (devRes.ok) {
          const devBody = await devRes.json() as { desktopAccess?: DesktopAccessState | null };
          liveDesktopAccess = devBody.desktopAccess ?? null;
        }
      } catch {
        // Network blip — fall back to the prop so the connect flow still runs.
      }

      // Auto-detect: fall back to VNC when the WebRTC path can't work but VNC relay is enabled.
      // Covers old macOS (unsupported_os), stuck helper (helper_not_connected), and virtual
      // display unavailable — all cases where native Screen Sharing via kickstart can still connect.
      const needsVNC = canFallbackToVNC(liveDesktopAccess, remoteAccessPolicy);

      if (needsVNC) {
        // Create VNC tunnel — user provides their macOS credentials in the noVNC prompt
        const tunnelRes = await fetchWithAuth('/tunnels', {
          method: 'POST',
          body: JSON.stringify({ deviceId, type: 'vnc' }),
        });

        if (!tunnelRes.ok) {
          const err = await tunnelRes.json().catch(() => ({ error: 'Failed to create VNC tunnel' }));
          throw new Error(err.error || 'Failed to create VNC tunnel');
        }

        const tunnel = await tunnelRes.json();

        // Issue a short-lived connect code for the Tauri viewer deep link (keeps JWT out of URL)
        const codeRes = await fetchWithAuth(`/tunnels/${tunnel.id}/connect-code`, { method: 'POST' });
        if (!codeRes.ok) {
          fetchWithAuth(`/tunnels/${tunnel.id}`, { method: 'DELETE' }).catch(() => {});
          throw new Error('Failed to issue VNC connect code');
        }
        const { code } = await codeRes.json();

        const apiUrl = import.meta.env.PUBLIC_API_URL || window.location.origin;
        const deepLink = `breeze://vnc?tunnel=${encodeURIComponent(tunnel.id)}` +
          `&device=${encodeURIComponent(deviceId)}` +
          `&api=${encodeURIComponent(apiUrl)}` +
          `&code=${encodeURIComponent(code)}`;

        setStatus('launching');

        // Try to hand off to the Breeze Viewer first
        tryDeepLink(deepLink);

        // Poll the tunnel to detect whether the viewer picked it up.
        // Tunnel moves from 'pending' → 'active' once the viewer connects.
        // If it stays pending after ~7.5 s, show the "Open in Browser" card.
        let vncPollCount = 0;
        const vncMaxPolls = 5;

        const pollVnc = async () => {
          vncPollCount++;
          try {
            const res = await fetchWithAuth(`/tunnels/${tunnel.id}`);
            if (res.ok) {
              const data = await res.json();
              if (data.status === 'active') {
                setStatus((cur) => cur === 'launching' || cur === 'fallback' ? 'idle' : cur);
                return;
              }
              if (data.status === 'failed') {
                setError(data.errorMessage || 'VNC tunnel failed to open');
                setStatus('idle');
                return;
              }
            }
          } catch { /* network error — keep polling */ }

          if (vncPollCount >= vncMaxPolls) {
            // Viewer didn't pick it up in time — show the fallback card so the
            // user can choose to open noVNC in the browser instead.
            setVncFallback({ tunnelId: tunnel.id });
            setStatus((cur) => cur === 'launching' ? 'fallback' : cur);

            if (autoDismissTimerRef.current) clearTimeout(autoDismissTimerRef.current);
            autoDismissTimerRef.current = setTimeout(() => {
              setStatus((cur) => cur === 'fallback' ? 'idle' : cur);
              setVncFallback(null);
            }, 30000);
            return;
          }

          pollTimerRef.current = setTimeout(pollVnc, 1500);
        };

        pollTimerRef.current = setTimeout(pollVnc, 1500);
        return;
      }

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
      const deepLink = `breeze://connect?session=${encodeURIComponent(session.id)}&code=${encodeURIComponent(codeData.code)}&api=${encodeURIComponent(apiUrl)}&device=${encodeURIComponent(deviceId)}`;

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
  }, [deviceId, desktopAccess, remoteAccessPolicy, endSession]);

  const handleDismiss = useCallback(() => {
    setVncFallback(null);
    setStatus('idle');
  }, []);

  const handleDismissAndCleanup = useCallback(() => {
    // End the session since the viewer didn't open
    if (sessionIdRef.current) {
      endSession(sessionIdRef.current);
      sessionIdRef.current = null;
    }
    setVncFallback(null);
    setStatus('idle');
  }, [endSession]);

  // VNC-specific: open noVNC in the browser when the viewer didn't pick up
  const handleOpenInBrowser = useCallback(() => {
    if (vncFallback) {
      window.open(buildRemoteVncPageUrl(vncFallback.tunnelId), '_blank');
    }
    setVncFallback(null);
    setStatus('idle');
  }, [vncFallback]);

  // VNC-specific: cancel — clean up the tunnel and dismiss
  const handleCancelVnc = useCallback(() => {
    if (vncFallback) {
      fetchWithAuth(`/tunnels/${vncFallback.tunnelId}`, { method: 'DELETE' }).catch(() => {});
      setVncFallback(null);
    }
    setStatus('idle');
  }, [vncFallback]);

  // Shared fallback content for both compact and full modes.
  // When the VNC auto-fallback path times out we show a "Open in Browser / Cancel"
  // card (blue, matching ConnectVncButton). When the WebRTC deep-link path times
  // out we show the existing "download viewer" card (amber).
  const fallbackContent = status === 'fallback' ? (
    vncFallback ? (
      // VNC path timed out — viewer didn't pick up the deep link
      <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm shadow-lg dark:border-blue-800 dark:bg-blue-950">
        <div className="flex items-start gap-2.5">
          <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
          <div className="flex-1">
            <p className="font-medium text-blue-800 dark:text-blue-300">
              Viewer didn't open?
            </p>
            <p className="mt-1 text-xs text-blue-700 dark:text-blue-400">
              Open the VNC session in your browser instead.
            </p>
            <div className="mt-2.5 flex items-center gap-3">
              <button
                type="button"
                onClick={handleOpenInBrowser}
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700"
              >
                <Globe className="h-3.5 w-3.5" />
                Open in Browser
              </button>
              <button
                type="button"
                onClick={handleCancelVnc}
                className="text-xs text-muted-foreground transition hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            className="flex h-5 w-5 items-center justify-center rounded hover:bg-blue-200 dark:hover:bg-blue-800"
          >
            <X className="h-3 w-3 text-blue-600 dark:text-blue-400" />
          </button>
        </div>
      </div>
    ) : (
      // WebRTC path timed out — viewer didn't pick up the deep link
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
    )
  ) : null;

  const headlessTitle = 'This device has no display \u2014 remote desktop is unavailable';
  const desktopAccessUnavailable = desktopAccessUnavailableReason(desktopAccess, remoteAccessPolicy);
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
