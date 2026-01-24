import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Terminal as TerminalIcon,
  Maximize2,
  Minimize2,
  Copy,
  X,
  Wifi,
  WifiOff,
  Loader2,
  RefreshCw
} from 'lucide-react';
import { cn } from '@/lib/utils';

// xterm.js will be loaded dynamically
type XTermInstance = {
  loadAddon: (addon: unknown) => void;
  open: (container: HTMLElement) => void;
  write: (data: string) => void;
  writeln: (data: string) => void;
  onData: (callback: (data: string) => void) => { dispose: () => void };
  onResize: (callback: (size: { cols: number; rows: number }) => void) => { dispose: () => void };
  dispose: () => void;
  focus: () => void;
  clear: () => void;
  rows: number;
  cols: number;
};

type FitAddonInstance = {
  fit: () => void;
  proposeDimensions: () => { cols: number; rows: number } | undefined;
};

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export type RemoteTerminalProps = {
  deviceId: string;
  deviceHostname: string;
  sessionId?: string;
  onSessionCreated?: (sessionId: string) => void;
  onDisconnect?: () => void;
  onError?: (error: string) => void;
  className?: string;
};

const statusConfig: Record<ConnectionStatus, { label: string; color: string; icon: typeof Wifi }> = {
  disconnected: { label: 'Disconnected', color: 'text-gray-500', icon: WifiOff },
  connecting: { label: 'Connecting...', color: 'text-yellow-500', icon: Loader2 },
  connected: { label: 'Connected', color: 'text-green-500', icon: Wifi },
  reconnecting: { label: 'Reconnecting...', color: 'text-yellow-500', icon: RefreshCw },
  failed: { label: 'Connection Failed', color: 'text-red-500', icon: WifiOff }
};

export default function RemoteTerminal({
  deviceId,
  deviceHostname,
  sessionId: initialSessionId,
  onSessionCreated,
  onDisconnect,
  onError,
  className
}: RemoteTerminalProps) {
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTermInstance | null>(null);
  const fitAddonRef = useRef<FitAddonInstance | null>(null);
  const webSocketRef = useRef<WebSocket | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId || null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [connectionTime, setConnectionTime] = useState<Date | null>(null);
  const [bytesTransferred, setBytesTransferred] = useState({ sent: 0, received: 0 });

  // Initialize xterm.js
  const initTerminal = useCallback(async () => {
    if (!terminalContainerRef.current || terminalRef.current) return;

    try {
      // Dynamic import of xterm.js
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');
      const { WebLinksAddon } = await import('@xterm/addon-web-links');

      // Import CSS
      await import('@xterm/xterm/css/xterm.css');

      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();

      const terminal = new Terminal({
        cursorBlink: true,
        cursorStyle: 'block',
        fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
        fontSize: 14,
        lineHeight: 1.2,
        theme: {
          background: '#1a1b26',
          foreground: '#a9b1d6',
          cursor: '#c0caf5',
          cursorAccent: '#1a1b26',
          selectionBackground: '#33467c',
          black: '#32344a',
          red: '#f7768e',
          green: '#9ece6a',
          yellow: '#e0af68',
          blue: '#7aa2f7',
          magenta: '#ad8ee6',
          cyan: '#449dab',
          white: '#787c99',
          brightBlack: '#444b6a',
          brightRed: '#ff7a93',
          brightGreen: '#b9f27c',
          brightYellow: '#ff9e64',
          brightBlue: '#7da6ff',
          brightMagenta: '#bb9af7',
          brightCyan: '#0db9d7',
          brightWhite: '#acb0d0'
        },
        scrollback: 10000,
        allowProposedApi: true
      });

      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);

      terminal.open(terminalContainerRef.current);
      fitAddon.fit();

      terminalRef.current = terminal as unknown as XTermInstance;
      fitAddonRef.current = fitAddon as unknown as FitAddonInstance;

      // Handle window resize
      resizeObserverRef.current = new ResizeObserver(() => {
        if (fitAddonRef.current) {
          fitAddonRef.current.fit();
        }
      });
      resizeObserverRef.current.observe(terminalContainerRef.current);

      // Display welcome message
      terminal.writeln('\x1b[1;34mBreeze RMM Remote Terminal\x1b[0m');
      terminal.writeln(`\x1b[90mConnecting to ${deviceHostname}...\x1b[0m`);
      terminal.writeln('');
    } catch (error) {
      console.error('Failed to initialize terminal:', error);
      onError?.('Failed to initialize terminal');
    }
  }, [deviceHostname, onError]);

  // Connect to remote session
  const connect = useCallback(async () => {
    if (!terminalRef.current) return;

    setStatus('connecting');

    try {
      // Create or use existing session
      let currentSessionId = sessionId;

      if (!currentSessionId) {
        const response = await fetch('/api/remote/sessions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('token')}`
          },
          body: JSON.stringify({
            deviceId,
            type: 'terminal'
          })
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Failed to create session');
        }

        const session = await response.json();
        currentSessionId = session.id;
        setSessionId(currentSessionId);
        if (currentSessionId) onSessionCreated?.(currentSessionId);
      }

      // Establish WebSocket connection for terminal data
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${window.location.host}/api/remote/sessions/${currentSessionId}/ws`;

      const ws = new WebSocket(wsUrl);
      webSocketRef.current = ws;

      ws.onopen = () => {
        setStatus('connected');
        setConnectionTime(new Date());
        terminalRef.current?.writeln('\x1b[1;32mConnected!\x1b[0m');
        terminalRef.current?.writeln('');
        terminalRef.current?.focus();
      };

      ws.onmessage = (event) => {
        if (terminalRef.current) {
          terminalRef.current.write(event.data);
          setBytesTransferred(prev => ({
            ...prev,
            received: prev.received + event.data.length
          }));
        }
      };

      ws.onerror = () => {
        setStatus('failed');
        terminalRef.current?.writeln('\x1b[1;31mConnection error\x1b[0m');
        onError?.('WebSocket connection error');
      };

      ws.onclose = (event) => {
        if (event.code !== 1000) {
          setStatus('failed');
          terminalRef.current?.writeln('\x1b[1;31mConnection closed unexpectedly\x1b[0m');
        } else {
          setStatus('disconnected');
          terminalRef.current?.writeln('\x1b[90mSession ended\x1b[0m');
        }
      };

      // Handle terminal input
      const dataDisposable = terminalRef.current.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
          setBytesTransferred(prev => ({
            ...prev,
            sent: prev.sent + data.length
          }));
        }
      });

      // Handle terminal resize
      const resizeDisposable = terminalRef.current.onResize((size: { cols: number; rows: number }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'resize',
            cols: size.cols,
            rows: size.rows
          }));
        }
      });

      // Store disposables for cleanup
      (ws as unknown as Record<string, unknown>)._disposables = [dataDisposable, resizeDisposable];
    } catch (error) {
      setStatus('failed');
      const message = error instanceof Error ? error.message : 'Connection failed';
      terminalRef.current?.writeln(`\x1b[1;31mError: ${message}\x1b[0m`);
      onError?.(message);
    }
  }, [deviceId, sessionId, onSessionCreated, onError]);

  // Disconnect from session
  const disconnect = useCallback(async () => {
    if (webSocketRef.current) {
      const disposables = (webSocketRef.current as unknown as Record<string, unknown[]>)._disposables;
      if (disposables) {
        for (const d of disposables) {
          (d as { dispose: () => void }).dispose();
        }
      }
      webSocketRef.current.close(1000);
      webSocketRef.current = null;
    }

    if (sessionId) {
      try {
        await fetch(`/api/remote/sessions/${sessionId}/end`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('token')}`
          },
          body: JSON.stringify({
            bytesTransferred: bytesTransferred.sent + bytesTransferred.received
          })
        });
      } catch (error) {
        console.error('Failed to end session:', error);
      }
    }

    setStatus('disconnected');
    setConnectionTime(null);
    onDisconnect?.();
  }, [sessionId, bytesTransferred, onDisconnect]);

  // Copy terminal content to clipboard
  const copyToClipboard = useCallback(async () => {
    if (!terminalContainerRef.current) return;

    const selection = window.getSelection();
    if (selection && selection.toString()) {
      await navigator.clipboard.writeText(selection.toString());
    }
  }, []);

  // Toggle fullscreen
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen(prev => !prev);
    // Fit terminal after state change
    setTimeout(() => {
      fitAddonRef.current?.fit();
    }, 100);
  }, []);

  // Initialize terminal on mount
  useEffect(() => {
    initTerminal();

    return () => {
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
      }
      if (webSocketRef.current) {
        webSocketRef.current.close();
      }
      if (terminalRef.current) {
        terminalRef.current.dispose();
      }
    };
  }, [initTerminal]);

  // Auto-connect after terminal is initialized
  useEffect(() => {
    if (terminalRef.current && status === 'disconnected' && !sessionId) {
      // Small delay to ensure terminal is ready
      const timer = setTimeout(() => {
        connect();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [terminalRef.current, status, sessionId, connect]);

  // Format connection duration
  const getConnectionDuration = () => {
    if (!connectionTime) return '';
    const seconds = Math.floor((Date.now() - connectionTime.getTime()) / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  };

  // Format bytes
  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const StatusIcon = statusConfig[status].icon;

  return (
    <div
      className={cn(
        'flex flex-col rounded-lg border bg-card shadow-sm overflow-hidden',
        isFullscreen && 'fixed inset-4 z-50',
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2">
        <div className="flex items-center gap-3">
          <TerminalIcon className="h-5 w-5 text-muted-foreground" />
          <div>
            <h3 className="font-semibold">{deviceHostname}</h3>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <StatusIcon
                className={cn(
                  'h-3 w-3',
                  statusConfig[status].color,
                  status === 'connecting' && 'animate-spin',
                  status === 'reconnecting' && 'animate-spin'
                )}
              />
              <span className={statusConfig[status].color}>
                {statusConfig[status].label}
              </span>
              {status === 'connected' && connectionTime && (
                <>
                  <span className="text-muted-foreground">|</span>
                  <span>{getConnectionDuration()}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {status === 'connected' && (
            <div className="text-xs text-muted-foreground mr-2">
              <span className="text-green-600">{formatBytes(bytesTransferred.received)}</span>
              {' / '}
              <span className="text-blue-600">{formatBytes(bytesTransferred.sent)}</span>
            </div>
          )}

          <button
            type="button"
            onClick={copyToClipboard}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            title="Copy selection"
          >
            <Copy className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={toggleFullscreen}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>

          {status === 'connected' ? (
            <button
              type="button"
              onClick={disconnect}
              className="flex h-8 items-center gap-1.5 rounded-md bg-red-500/10 px-3 text-sm font-medium text-red-600 hover:bg-red-500/20"
            >
              <X className="h-4 w-4" />
              Disconnect
            </button>
          ) : status === 'failed' ? (
            <button
              type="button"
              onClick={connect}
              className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              <RefreshCw className="h-4 w-4" />
              Retry
            </button>
          ) : null}
        </div>
      </div>

      {/* Terminal Container */}
      <div
        ref={terminalContainerRef}
        className={cn(
          'flex-1 min-h-[400px] bg-[#1a1b26]',
          isFullscreen && 'min-h-0'
        )}
        style={{ padding: '8px' }}
      />
    </div>
  );
}
