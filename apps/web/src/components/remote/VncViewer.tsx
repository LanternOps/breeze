import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Maximize2,
  Minimize2,
  Clipboard,
  MonitorOff,
  Loader2,
  Scaling,
  Wifi,
  WifiOff,
  Lock,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error' | 'password_required';

interface VncViewerProps {
  wsUrl: string;
  tunnelId: string;
  password?: string;
  onDisconnect?: () => void;
  className?: string;
}

const statusConfig: Record<ConnectionStatus, { label: string; color: string }> = {
  connecting: { label: 'Connecting...', color: 'text-amber-500' },
  connected: { label: 'Connected', color: 'text-green-500' },
  disconnected: { label: 'Disconnected', color: 'text-gray-500' },
  error: { label: 'Connection Error', color: 'text-red-500' },
  password_required: { label: 'Password required', color: 'text-amber-500' },
};

export default function VncViewer({ wsUrl, tunnelId, password, onDisconnect, className }: VncViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<any>(null);

  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [scaleViewport, setScaleViewport] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [passwordInput, setPasswordInput] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [needsUsername, setNeedsUsername] = useState(false);

  // Connect RFB on mount
  useEffect(() => {
    if (!containerRef.current) return;

    let rfb: any = null;
    let disposed = false;

    async function connect() {
      const { RFB } = await import('@/lib/novnc');
      if (disposed || !containerRef.current) return;

      const c = containerRef.current;
      console.log('[VNC] container size at connect:', c.clientWidth, 'x', c.clientHeight);

      rfb = new RFB(c, wsUrl, {
        wsProtocols: ['binary'],
      });

      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.showDotCursor = true;

      rfb.addEventListener('connect', () => {
        if (!disposed) setStatus('connected');
        console.log('[VNC] connected; framebuffer:',
          rfb._fbWidth || 'unknown', 'x', rfb._fbHeight || 'unknown',
          'scheme:', rfb._rfbAuthScheme);
      });

      rfb.addEventListener('disconnect', (e: CustomEvent) => {
        console.log('[VNC] disconnect', e.detail);
        if (disposed) return;
        if (e.detail?.clean) {
          setStatus('disconnected');
        } else {
          setStatus('error');
          setErrorMessage('Connection lost unexpectedly');
        }
        onDisconnect?.();
      });

      rfb.addEventListener('credentialsrequired', (e: CustomEvent) => {
        console.log('[VNC] credentialsrequired', e.detail);
        if (disposed) return;
        // `detail.types` tells us what the selected security scheme needs.
        // Apple Remote Desktop auth (type 30) requires ["username", "password"];
        // standard VNC auth (type 2) requires just ["password"].
        const types = (e.detail?.types ?? ['password']) as string[];
        const requiresUsername = types.includes('username');
        if (password && !requiresUsername) {
          rfb.sendCredentials({ password });
        } else {
          setNeedsUsername(requiresUsername);
          setStatus('password_required');
        }
      });

      // Diagnostic: framebuffer updates, resize, errors
      rfb.addEventListener('desktopname', (e: CustomEvent) => {
        console.log('[VNC] desktopname:', e.detail);
      });
      rfb.addEventListener('capabilities', (e: CustomEvent) => {
        console.log('[VNC] capabilities:', e.detail);
      });
      rfb.addEventListener('securityfailure', (e: CustomEvent) => {
        console.warn('[VNC] securityfailure:', e.detail);
        if (disposed) return;
        const reason = e.detail?.reason || 'Authentication failed';
        setStatus('error');
        setErrorMessage(
          e.detail?.status === 1 ? `Authentication failed: ${reason}. Check your VNC password.`
          : e.detail?.status === 2 ? `Security type not supported: ${reason}`
          : `Security failure: ${reason}`
        );
      });
      rfb.addEventListener('clipboard', (e: CustomEvent) => {
        console.log('[VNC] clipboard:', e.detail?.text?.length, 'bytes');
      });

      // Hook the socket's raw send to count outgoing bytes and spot fbUpdateRequests.
      let bytesSent = 0;
      let bytesRecv = 0;
      let fbuRequestsSent = 0;
      let fbuReceived = 0;
      const origSend = rfb._sock.flush?.bind(rfb._sock);
      if (origSend) {
        rfb._sock.flush = function () {
          const q = this._sQ;
          const len = this._sQlen || 0;
          bytesSent += len;
          // FramebufferUpdateRequest starts with type byte 3.
          if (len >= 10 && q && q[0] === 3) fbuRequestsSent++;
          return origSend();
        };
      }
      // Hook message handler to count bytes received.
      const origHandleMessage = rfb._handleMessage?.bind(rfb);
      if (origHandleMessage) {
        rfb._handleMessage = function () {
          try {
            const before = this._sock?._rQlen || 0;
            const ret = origHandleMessage();
            const after = this._sock?._rQlen || 0;
            bytesRecv += Math.max(0, before - after);
            return ret;
          } catch (e) {
            return origHandleMessage();
          }
        };
      }
      // Hook _framebufferUpdate completion to count received frames.
      const origFBU = rfb._framebufferUpdate?.bind(rfb);
      if (origFBU) {
        rfb._framebufferUpdate = function () {
          const ret = origFBU();
          if (ret && this._FBU.rects === 0) fbuReceived++;
          return ret;
        };
      }

      // Diagnostic: poll WebSocket byte counts + canvas element state every 2s.
      const diagInterval = setInterval(() => {
        if (disposed) return;
        try {
          const sock = rfb._sock;
          const display = rfb._display;
          const canvas = display?._target as HTMLCanvasElement | undefined;
          const wsState = sock?._websocket?.readyState ?? 'n/a';
          console.log('[VNC-diag]',
            'ws:', wsState,
            'canvas:', canvas ? `${canvas.width}x${canvas.height}` : 'no-canvas',
            'fb:', `${rfb._fbWidth}x${rfb._fbHeight}`,
            'FBUs-recv:', fbuReceived,
            'FBU-reqs-sent:', fbuRequestsSent,
            'bytes recv/sent:', bytesRecv, '/', bytesSent,
            'pending-rects:', rfb._FBU?.rects,
            'rQ-len:', sock?._rQlen,
            'flushing:', rfb._flushing);
        } catch {
          // noVNC internals changed — diagnostics degraded, not fatal
        }
      }, 2000);

      const cleanupDiag = () => clearInterval(diagInterval);
      rfb.addEventListener('disconnect', cleanupDiag);

      rfbRef.current = rfb;
    }

    connect().catch((err) => {
      if (!disposed) {
        setStatus('error');
        setErrorMessage(err instanceof Error ? err.message : 'Failed to load VNC viewer');
      }
    });

    return () => {
      disposed = true;
      if (rfb) {
        rfb.disconnect();
        rfb = null;
      }
      rfbRef.current = null;
    };
  }, [wsUrl, password, onDisconnect]);

  // Sync scale setting to RFB instance
  useEffect(() => {
    if (rfbRef.current) {
      rfbRef.current.scaleViewport = scaleViewport;
      rfbRef.current.resizeSession = !scaleViewport;
    }
  }, [scaleViewport]);

  // When the container resizes (fullscreen, window resize, etc.), nudge noVNC
  // to recompute its scaled viewport — otherwise the canvas stays at the size
  // from first connect and you get a tiny canvas with huge black margins.
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      const rfb = rfbRef.current;
      if (rfb && rfb.scaleViewport) {
        // Toggling scaleViewport forces noVNC to re-run its viewport math.
        rfb.scaleViewport = false;
        rfb.scaleViewport = true;
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const handleDisconnect = useCallback(() => {
    rfbRef.current?.disconnect();
    rfbRef.current = null;
    setStatus('disconnected');
    onDisconnect?.();
  }, [onDisconnect]);

  const submitPassword = useCallback(() => {
    if (!rfbRef.current || !passwordInput) return;
    if (needsUsername && !usernameInput) return;
    const creds: { password: string; username?: string } = { password: passwordInput };
    if (needsUsername) creds.username = usernameInput;
    rfbRef.current.sendCredentials(creds);
    setStatus('connecting');
    setPasswordInput('');
    setUsernameInput('');
  }, [passwordInput, usernameInput, needsUsername]);

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev);
  }, []);

  const toggleScaling = useCallback(() => {
    setScaleViewport((prev) => !prev);
  }, []);

  const syncClipboard = useCallback(async () => {
    if (!rfbRef.current) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        rfbRef.current.clipboardPasteFrom(text);
      }
    } catch {
      console.warn('[VNC] Clipboard sync failed — browser may have denied permission');
    }
  }, []);

  const StatusIcon = status === 'connecting' ? Loader2
    : status === 'connected' ? Wifi
    : status === 'password_required' ? Lock
    : WifiOff;

  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col rounded-lg border bg-card shadow-sm overflow-hidden',
        isFullscreen && 'fixed inset-4 z-50',
        className,
      )}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs">
            <StatusIcon
              className={cn(
                'h-3.5 w-3.5',
                statusConfig[status].color,
                status === 'connecting' && 'animate-spin',
              )}
            />
            <span className={statusConfig[status].color}>
              {statusConfig[status].label}
            </span>
          </div>
          {status === 'connected' && (
            <span className="text-xs text-muted-foreground">
              Tunnel {tunnelId.slice(0, 8)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={syncClipboard}
            disabled={status !== 'connected'}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
            title="Sync clipboard to remote"
          >
            <Clipboard className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={toggleScaling}
            disabled={status !== 'connected'}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed',
              scaleViewport && 'bg-muted',
            )}
            title={scaleViewport ? 'Scaling: fit to window' : 'Scaling: native resolution'}
          >
            <Scaling className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={toggleFullscreen}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>

          <button
            type="button"
            onClick={handleDisconnect}
            disabled={status === 'disconnected'}
            className="flex h-8 items-center gap-1.5 rounded-md bg-red-500/10 px-3 text-sm font-medium text-red-600 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <MonitorOff className="h-4 w-4" />
            Disconnect
          </button>
        </div>
      </div>

      {/* VNC canvas container */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 bg-black overflow-hidden relative flex items-center justify-center"
      >
        {status === 'password_required' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm z-10">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitPassword();
              }}
              className="w-full max-w-sm rounded-lg border border-gray-700 bg-gray-900 p-6 shadow-xl"
            >
              <div className="mb-4 flex items-center gap-2 text-gray-100">
                <Lock className="h-5 w-5 text-amber-400" />
                <h3 className="text-base font-semibold">
                  {needsUsername ? 'macOS login required' : 'VNC password required'}
                </h3>
              </div>
              <p className="mb-4 text-sm text-gray-400">
                {needsUsername
                  ? 'The Mac is using Apple Remote Desktop authentication. Enter a macOS user account with Screen Sharing access (the user\'s login name and password).'
                  : 'Enter the password set in System Settings > General > Sharing > Screen Sharing > Computer Settings.'}
              </p>
              {needsUsername && (
                <input
                  autoFocus
                  type="text"
                  autoComplete="username"
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                  placeholder="macOS username"
                  className="mb-3 w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
              )}
              <input
                autoFocus={!needsUsername}
                type="password"
                autoComplete="current-password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder={needsUsername ? 'macOS password' : 'Password'}
                className="mb-4 w-full rounded-md border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="rounded-md px-3 py-1.5 text-sm text-gray-400 hover:bg-gray-800 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!passwordInput || (needsUsername && !usernameInput)}
                  className="rounded-md bg-amber-500 px-3 py-1.5 text-sm font-medium text-gray-900 hover:bg-amber-400 disabled:opacity-50"
                >
                  Connect
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

      {/* Error banner */}
      {status === 'error' && errorMessage && (
        <div className="border-t border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          {errorMessage}
        </div>
      )}
    </div>
  );
}
