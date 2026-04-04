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
} from 'lucide-react';
import { cn } from '@/lib/utils';

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface VncViewerProps {
  wsUrl: string;
  tunnelId: string;
  onDisconnect?: () => void;
  className?: string;
}

const statusConfig: Record<ConnectionStatus, { label: string; color: string }> = {
  connecting: { label: 'Connecting...', color: 'text-amber-500' },
  connected: { label: 'Connected', color: 'text-green-500' },
  disconnected: { label: 'Disconnected', color: 'text-gray-500' },
  error: { label: 'Connection Error', color: 'text-red-500' },
};

export default function VncViewer({ wsUrl, tunnelId, onDisconnect, className }: VncViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<any>(null);

  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [scaleViewport, setScaleViewport] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Connect RFB on mount
  useEffect(() => {
    if (!containerRef.current) return;

    let rfb: any = null;
    let disposed = false;

    async function connect() {
      const { default: RFB } = await import('@novnc/novnc/core/rfb');
      if (disposed || !containerRef.current) return;

      rfb = new RFB(containerRef.current, wsUrl, {
        wsProtocols: ['binary'],
      });

      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.showDotCursor = true;

      rfb.addEventListener('connect', () => {
        if (!disposed) setStatus('connected');
      });

      rfb.addEventListener('disconnect', (e: CustomEvent) => {
        if (disposed) return;
        if (e.detail?.clean) {
          setStatus('disconnected');
        } else {
          setStatus('error');
          setErrorMessage('Connection lost unexpectedly');
        }
        onDisconnect?.();
      });

      rfb.addEventListener('credentialsrequired', () => {
        // noVNC handles password prompt natively in the canvas
      });

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
  }, [wsUrl, onDisconnect]);

  // Sync scale setting to RFB instance
  useEffect(() => {
    if (rfbRef.current) {
      rfbRef.current.scaleViewport = scaleViewport;
      rfbRef.current.resizeSession = !scaleViewport;
    }
  }, [scaleViewport]);

  const handleDisconnect = useCallback(() => {
    rfbRef.current?.disconnect();
    rfbRef.current = null;
    setStatus('disconnected');
    onDisconnect?.();
  }, [onDisconnect]);

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
      // Clipboard API may be blocked by permissions
    }
  }, []);

  const StatusIcon = status === 'connecting' ? Loader2
    : status === 'connected' ? Wifi
    : WifiOff;

  return (
    <div
      className={cn(
        'flex flex-col rounded-lg border bg-card shadow-sm overflow-hidden',
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
        className={cn(
          'flex-1 min-h-[400px] bg-black overflow-hidden',
          isFullscreen && 'min-h-0',
        )}
      />

      {/* Error banner */}
      {status === 'error' && errorMessage && (
        <div className="border-t border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          {errorMessage}
        </div>
      )}
    </div>
  );
}
