import { useState, useCallback, useRef, useEffect } from 'react';
import { Monitor, ExternalLink, X, Globe } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';

interface Props {
  deviceId: string;
  className?: string;
  compact?: boolean;
  iconOnly?: boolean;
  disabled?: boolean;
  /** When true, shown as primary option (e.g., macOS < 14 login-window fallback) */
  primary?: boolean;
}

/**
 * VNC remote desktop via tunnel relay. Creates a TCP tunnel to the device's
 * VNC server (localhost:5900) and launches the Breeze viewer in VNC mode
 * or falls back to an in-browser noVNC viewer.
 */
export default function ConnectVncButton({
  deviceId,
  className = '',
  compact = false,
  iconOnly = false,
  disabled = false,
  primary = false,
}: Props) {
  const [status, setStatus] = useState<'idle' | 'creating' | 'launching' | 'fallback'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [tunnelId, setTunnelId] = useState<string | null>(null);
  const [vncWsUrl, setVncWsUrl] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const autoDismissRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
    };
  }, []);

  const closeTunnel = useCallback((tid: string) => {
    fetchWithAuth(`/tunnels/${tid}`, { method: 'DELETE' }).catch(() => {});
  }, []);

  const handleConnect = useCallback(async () => {
    setStatus('creating');
    setError(null);

    try {
      // Create VNC tunnel
      const tunnelRes = await fetchWithAuth('/tunnels', {
        method: 'POST',
        body: JSON.stringify({ deviceId, type: 'vnc' }),
      });

      if (!tunnelRes.ok) {
        const err = await tunnelRes.json().catch(() => ({ error: 'Failed to create tunnel' }));
        throw new Error(err.error || 'Failed to create VNC tunnel');
      }

      const tunnel = await tunnelRes.json();
      setTunnelId(tunnel.id);

      // Get WS ticket for the tunnel
      const ticketRes = await fetchWithAuth(`/tunnels/${tunnel.id}/ws-ticket`, { method: 'POST' });
      if (!ticketRes.ok) {
        closeTunnel(tunnel.id);
        throw new Error('Failed to get tunnel ticket');
      }
      const { ticket } = await ticketRes.json();

      // Build WebSocket URL and deep link
      const apiUrl = import.meta.env.PUBLIC_API_URL || window.location.origin;
      const wsProtocol = apiUrl.startsWith('https') ? 'wss' : 'ws';
      const wsHost = apiUrl.replace(/^https?:\/\//, '');
      const wsUrl = `${wsProtocol}://${wsHost}/api/v1/tunnel-ws/${tunnel.id}/ws?ticket=${ticket}`;
      setVncWsUrl(wsUrl);

      const deepLink = `breeze://vnc?tunnel=${encodeURIComponent(tunnel.id)}&ws=${encodeURIComponent(wsUrl)}`;

      setStatus('launching');

      // Try to open in Tauri viewer app
      const a = document.createElement('a');
      a.href = deepLink;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 100);

      // Poll tunnel status
      let pollCount = 0;
      const maxPolls = 5;

      const poll = async () => {
        pollCount++;
        try {
          const res = await fetchWithAuth(`/tunnels/${tunnel.id}`);
          if (res.ok) {
            const data = await res.json();
            if (data.status === 'active') {
              setStatus(cur => cur === 'launching' || cur === 'fallback' ? 'idle' : cur);
              return;
            }
            if (data.status === 'failed') {
              throw new Error(data.errorMessage || 'Tunnel failed to open');
            }
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes('failed')) {
            setError(e.message);
            setStatus('idle');
            return;
          }
        }

        if (pollCount >= maxPolls) {
          setStatus(cur => cur === 'launching' ? 'fallback' : cur);
          autoDismissRef.current = setTimeout(() => {
            setStatus(cur => cur === 'fallback' ? 'idle' : cur);
          }, 30000);
          return;
        }

        pollTimerRef.current = setTimeout(poll, 1500);
      };

      pollTimerRef.current = setTimeout(poll, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      setStatus('idle');
    }
  }, [deviceId, closeTunnel]);

  const handleOpenInBrowser = useCallback(() => {
    if (tunnelId && vncWsUrl) {
      // Open noVNC viewer in a new tab
      const viewerUrl = `/remote/vnc/${tunnelId}?ws=${encodeURIComponent(vncWsUrl)}`;
      window.open(viewerUrl, '_blank');
    }
    setStatus('idle');
  }, [tunnelId, vncWsUrl]);

  const handleDismiss = useCallback(() => {
    setStatus('idle');
  }, []);

  const handleDismissAndCleanup = useCallback(() => {
    if (tunnelId) {
      closeTunnel(tunnelId);
      setTunnelId(null);
    }
    setStatus('idle');
  }, [tunnelId, closeTunnel]);

  // Fallback: offer in-browser noVNC viewer
  const fallbackContent = status === 'fallback' ? (
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
              onClick={handleDismissAndCleanup}
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
  ) : null;

  const label = primary ? 'VNC Desktop' : 'VNC Remote';
  const buttonLabel =
    error ? 'Connection failed' :
    status === 'creating' ? 'Creating tunnel...' :
    status === 'launching' ? 'Launching...' :
    label;

  if (iconOnly) {
    return (
      <div className={`relative ${className}`}>
        <button
          type="button"
          onClick={handleConnect}
          disabled={disabled || status === 'creating' || status === 'launching'}
          title={error || label}
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
          disabled={disabled || status === 'creating' || status === 'launching'}
          title={error || undefined}
          className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 ${error ? 'text-red-500' : ''}`}
        >
          <Monitor className="h-4 w-4" />
          {buttonLabel}
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
        disabled={disabled || status === 'creating' || status === 'launching'}
        title={error || undefined}
        className={`flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${error ? 'border-red-300 bg-red-50 text-red-600 hover:bg-red-100 dark:border-red-800 dark:bg-red-950 dark:text-red-400 dark:hover:bg-red-900' : 'bg-background hover:bg-muted'}`}
      >
        <Monitor className="h-4 w-4" />
        {buttonLabel}
        {status === 'idle' && !error && <ExternalLink className="w-3.5 h-3.5 opacity-60" />}
      </button>
      {fallbackContent}
    </div>
  );
}
