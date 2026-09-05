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
import { fetchWithAuth } from '@/stores/auth';
import { formatNumber } from '@/lib/i18n/format';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

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

// Client-side keepalive (issue #2871). The server pings every 30s and closes
// the socket when no liveness signal arrives within 40s — but it also accepts
// a client-initiated {type:'ping'} as liveness. Sending our own pings makes
// the keepalive survive a lost server→client ping, and expecting *some*
// server frame (ping, pong, or output) lets the client detect a half-dead
// connection instead of freezing silently.
//
// Contract with apps/api/src/routes/terminalWs.ts (PING_INTERVAL_MS = 30s,
// PONG_TIMEOUT_MS = 10s): CLIENT_PING_INTERVAL_MS must stay well under the
// server's 40s deadline, and SERVER_SILENCE_TIMEOUT_MS must stay above the
// server's ping interval — otherwise healthy idle sessions get killed on
// whichever side drifted.
// Identifies the single <style> element carrying xterm's stylesheet. The CSS
// is inlined into this component's chunk (see initTerminal), so it has to be
// attached to the document exactly once no matter how many times the terminal
// mounts.
const XTERM_STYLE_ELEMENT_ID = 'xterm-css';

const CLIENT_PING_INTERVAL_MS = 20_000;
const SERVER_SILENCE_TIMEOUT_MS = 45_000;
const LIVENESS_CHECK_INTERVAL_MS = 5_000;

const statusConfig: Record<ConnectionStatus, { labelKey: string; color: string; icon: typeof Wifi }> = {
  disconnected: { labelKey: 'remoteTerminal.status.disconnected', color: 'text-gray-500', icon: WifiOff },
  connecting: { labelKey: 'remoteTerminal.status.connecting', color: 'text-yellow-500', icon: Loader2 },
  connected: { labelKey: 'remoteTerminal.status.connected', color: 'text-green-500', icon: Wifi },
  reconnecting: { labelKey: 'remoteTerminal.status.reconnecting', color: 'text-yellow-500', icon: RefreshCw },
  failed: { labelKey: 'remoteTerminal.status.failed', color: 'text-red-500', icon: WifiOff }
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
  const { t } = useTranslation('remote');
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTermInstance | null>(null);
  const fitAddonRef = useRef<FitAddonInstance | null>(null);
  const webSocketRef = useRef<WebSocket | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const disconnectFiredRef = useRef(false);
  // Each connect() owns a generation. A ws-ticket is single use and is spent by
  // the handshake, so an attempt the server refused is dead the instant it is
  // refused — anything it reports afterwards (a late open, a late frame) must
  // not drive the UI or the wire.
  const connectAttemptRef = useRef(0);

  // initTerminal must be immune to prop-identity churn (deviceHostname flips
  // ~100-300ms after mount once the parent's device fetch resolves; onError/t
  // can also change identity across renders). These refs hold the latest
  // value for use inside the one-shot init routine without pulling them into
  // its dependency array — see initTerminal below and issue #4152.
  const deviceHostnameRef = useRef(deviceHostname);
  const onErrorRef = useRef(onError);
  const tRef = useRef(t);
  deviceHostnameRef.current = deviceHostname;
  onErrorRef.current = onError;
  tRef.current = t;
  // The hostname actually announced in the terminal's "connecting to" line so
  // far. Compared against the live prop by the effect below to decide whether
  // to write an updated line — never to decide whether to re-init.
  const announcedHostnameRef = useRef<string | null>(null);
  // Set synchronously the instant init starts (before the first await), so a
  // second invocation can never slip past the guard while the first is still
  // mid-flight — this is what actually prevents the double-init race, not the
  // terminalRef null-check alone (that check happens too late: it stays null
  // until well after the first `await import(...)`).
  const initStartedRef = useRef(false);

  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  // Tracks whether the one-shot auto-connect has already fired. This gates the
  // auto-connect effect so it runs exactly once, on initial mount: without it,
  // the disconnected+no-session state produced by a manual Disconnect (or a
  // clean server-side session end) re-satisfies the effect's condition and it
  // silently reconnects — defeating the Disconnect button (issue #2137). After
  // the first attempt, reconnecting requires an explicit user action (the
  // Reconnect / Retry button). It is state (not a ref) so the same flag also
  // reactively drives the Reconnect button's visibility.
  const [autoConnectAttempted, setAutoConnectAttempted] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId || null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [connectionTime, setConnectionTime] = useState<Date | null>(null);
  const [bytesTransferred, setBytesTransferred] = useState({ sent: 0, received: 0 });
  const [terminalReady, setTerminalReady] = useState(false);

  // Initialize xterm.js. Deliberately has no dependencies: this must run
  // exactly once per mount, immune to deviceHostname/onError/t identity
  // changes (issue #4152). Anything that can change after mount is read via
  // a ref (deviceHostnameRef/onErrorRef/tRef) instead of being captured in
  // the closure via the dependency array.
  const initTerminal = useCallback(async () => {
    if (!terminalContainerRef.current || initStartedRef.current) return;
    // Flip this synchronously, before any await, so a second invocation
    // triggered while this one is still mid-flight (e.g. a hostname prop
    // update landing between the dynamic imports below) can never pass the
    // guard and start a second terminal.
    initStartedRef.current = true;

    try {
      // Dynamic import of xterm.js
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');
      const { WebLinksAddon } = await import('@xterm/addon-web-links');

      // xterm's stylesheet ships INSIDE this lazy chunk (`?inline` hands us
      // the CSS as a string) instead of as a separate hashed .css asset, and
      // that is the actual fix for #4152.
      //
      // A plain `import '@xterm/xterm/css/xterm.css'` compiles to Vite's
      // preload helper injecting a `<link rel=stylesheet>` and awaiting its
      // `load` event — a promise that REJECTS on `error`. It does reject in
      // the field: after an upgrade a stale hashed URL returns the SPA's
      // index.html, which `nosniff` refuses to treat as CSS. Awaited bare,
      // that lone rejection unwound the rest of init and left a permanently
      // dead pane. Worse, the helper memoises attempted deps in a
      // module-level `seen` map, so the remount that appeared to "fix" it
      // (a tab round-trip) merely SKIPPED the stylesheet — the terminal came
      // back styleless, and xterm.css is not decorative: it positions
      // `.xterm-viewport`, absolutely stacks the `.xterm-screen` canvases and
      // hides `.xterm-helper-textarea`, the offscreen textarea that captures
      // keyboard/IME input.
      //
      // Inlining removes the whole failure class: there is no second asset to
      // go stale, and the CSS cannot arrive without the JS that needs it. The
      // catch is defence in depth only — a styling problem must never again be
      // able to take the session down with it.
      try {
        const { default: xtermCss } = await import('@xterm/xterm/css/xterm.css?inline');
        // Idempotent: remounts (every Remote Tools tab switch is one) and the
        // second terminal on a split view must not stack duplicate <style>
        // elements. Injecting a <style> is CSP-legal here — apps/web already
        // carries style-src 'unsafe-inline' for xterm's runtime inline styles.
        if (xtermCss && !document.getElementById(XTERM_STYLE_ELEMENT_ID)) {
          const style = document.createElement('style');
          style.id = XTERM_STYLE_ELEMENT_ID;
          style.textContent = xtermCss;
          document.head.appendChild(style);
        }
      } catch (cssError) {
        console.warn(
          'Terminal stylesheet failed to load; continuing with an unstyled terminal:',
          cssError
        );
      }

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
          foreground: '#f8f8f2',
          cursor: '#f8f8f2',
          cursorAccent: '#1a1b26',
          selectionBackground: '#33467c',
          black: '#6b7394',
          red: '#f7768e',
          green: '#9ece6a',
          yellow: '#e0af68',
          blue: '#7aa2f7',
          magenta: '#bb9af7',
          cyan: '#7dcfff',
          white: '#f8f8f2',
          brightBlack: '#9aa5ce',
          brightRed: '#ff9e9e',
          brightGreen: '#c3e88d',
          brightYellow: '#ffc777',
          brightBlue: '#82aaff',
          brightMagenta: '#c8a8f7',
          brightCyan: '#89ddff',
          brightWhite: '#f0f2f8'
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

      // Display welcome message. Read the hostname/translator via refs so
      // this stays correct even though this callback has no deps: it always
      // sees the latest value at the moment init actually runs.
      const hostnameAtInit = deviceHostnameRef.current;
      terminal.writeln(`\x1b[1;34m${tRef.current('remoteTerminal.welcome')}\x1b[0m`);
      terminal.writeln(`\x1b[90m${tRef.current('remoteTerminal.connectingTo', { hostname: hostnameAtInit })}\x1b[0m`);
      terminal.writeln('');
      announcedHostnameRef.current = hostnameAtInit;

      // Signal that terminal is ready for connection
      setTerminalReady(true);
    } catch (error) {
      console.error('Failed to initialize terminal:', error);
      // Release the one-shot guard so the user can retry without remounting.
      // It is only otherwise cleared by unmount cleanup, which is why a failed
      // cold mount used to need a tab round-trip to recover (#4152).
      initStartedRef.current = false;
      // Surface the failure. Without this the pane keeps the initial
      // 'disconnected' status while `autoConnectAttempted` stays false (the
      // auto-connect effect is gated on `terminalReady`, which never flips),
      // so the retry overlay's condition is never satisfied and the user is
      // left with an empty pane and nothing to click.
      setStatus('failed');
      onErrorRef.current?.(tRef.current('remoteTerminal.errors.initialize'));
    }
  }, []);

  // Connect to remote session
  const connect = useCallback(async () => {
    if (!terminalRef.current) return;

    const attempt = ++connectAttemptRef.current;
    const isStale = () => connectAttemptRef.current !== attempt;

    setStatus('connecting');

    try {
      // Create or use existing session
      let currentSessionId = sessionId;

      if (!currentSessionId) {
        const response = await fetchWithAuth('/remote/sessions', {
          method: 'POST',
          body: JSON.stringify({
            deviceId,
            type: 'terminal'
          })
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || t('remoteTerminal.errors.createSession'));
        }

        const session = await response.json();
        currentSessionId = session.id;
        setSessionId(currentSessionId);
        if (currentSessionId) onSessionCreated?.(currentSessionId);
      }

      const ticketResponse = await fetchWithAuth(`/remote/sessions/${currentSessionId}/ws-ticket`, {
        method: 'POST'
      });
      if (!ticketResponse.ok) {
        const error = await ticketResponse.json().catch(() => ({ error: t('remoteTerminal.errors.createTicket') }));
        throw new Error(error.error || t('remoteTerminal.errors.createTicket'));
      }
      const { ticket } = await ticketResponse.json() as { ticket?: string };
      if (!ticket) {
        throw new Error(t('remoteTerminal.errors.invalidTicket'));
      }

      // Establish WebSocket connection for terminal data
      // Connect directly to API server for WebSocket (Astro SSR doesn't proxy WebSocket)
      const apiHost = import.meta.env.PUBLIC_API_URL || window.location.origin;
      const wsProtocol = apiHost.startsWith('https') ? 'wss:' : 'ws:';
      const apiHostname = apiHost.replace(/^https?:\/\//, '');
      const wsUrl = `${wsProtocol}//${apiHostname}/api/v1/remote/sessions/${currentSessionId}/ws?ticket=${encodeURIComponent(ticket)}`;

      if (isStale()) return;

      const ws = new WebSocket(wsUrl);
      webSocketRef.current = ws;

      // Track whether the server has confirmed the session is ready.
      // We must not send any messages (resize, data) until then.
      let serverReady = false;
      // The server now decides admission *before* the HTTP 101 upgrade
      // (401/403/409/429). Browsers never surface that status to the WebSocket
      // API — the only observable signal is an error/close with no preceding
      // open — so track the open ourselves and treat a pre-open failure as a
      // rejected handshake rather than a mid-session disconnect.
      let opened = false;
      let attemptDisposed = false;
      const disposables: Array<{ dispose: () => void }> = [];

      // Liveness bookkeeping for this attempt. Any frame from the server
      // (output, connected, ping, pong, error) proves the server→client leg
      // is alive; the watchdog below turns prolonged silence into a visible
      // disconnect instead of a frozen terminal.
      let lastServerFrameAt = Date.now();
      let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
      let livenessInterval: ReturnType<typeof setInterval> | null = null;
      const clearKeepaliveTimers = () => {
        if (keepaliveInterval) clearInterval(keepaliveInterval);
        keepaliveInterval = null;
        if (livenessInterval) clearInterval(livenessInterval);
        livenessInterval = null;
      };

      /**
       * Tears down exactly this attempt: unhooks terminal input, detaches every
       * socket listener (so a late event is inert), and closes the socket. The
       * ticket in `wsUrl` is spent and is dropped with it.
       */
      const disposeAttempt = () => {
        // Always drain the list: listeners can be appended after a rejection
        // has already fired (the handshake can fail while they are being wired).
        for (const d of disposables) d.dispose();
        disposables.length = 0;
        clearKeepaliveTimers();
        if (attemptDisposed) return;
        attemptDisposed = true;
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        if (webSocketRef.current === ws) webSocketRef.current = null;
        try {
          ws.close();
        } catch {
          // Already closing/closed — nothing to unwind.
        }
      };

      ws.onopen = () => {
        if (isStale()) {
          disposeAttempt();
          return;
        }
        opened = true;
        setStatus('connecting');
        terminalRef.current?.writeln(`\x1b[1;32m${t('remoteTerminal.connectedBang')}\x1b[0m`);
        terminalRef.current?.writeln('');
        terminalRef.current?.focus();

        lastServerFrameAt = Date.now();
        // Client-initiated keepalive: the server records our ping as liveness
        // (and answers with a pong), so the session survives even if a
        // server→client ping frame is lost.
        keepaliveInterval = setInterval(() => {
          if (serverReady && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: 'ping' }));
            } catch {
              // A dead socket is surfaced by the liveness watchdog below.
            }
          }
        }, CLIENT_PING_INTERVAL_MS);
        // Server-silence watchdog: a healthy session receives a server frame
        // at least every 30s (server ping) plus pong replies to our pings.
        // Prolonged silence means the connection is dead even if no TCP close
        // ever arrives — surface it instead of freezing (issue #2871).
        livenessInterval = setInterval(() => {
          if (isStale() || attemptDisposed) {
            clearKeepaliveTimers();
            return;
          }
          if (!serverReady) return;
          if (Date.now() - lastServerFrameAt <= SERVER_SILENCE_TIMEOUT_MS) return;
          disposeAttempt();
          setStatus('failed');
          setSessionId(null);
          terminalRef.current?.writeln(`\x1b[1;31m${t('remoteTerminal.errors.closedUnexpectedly')}\x1b[0m`);
          callOnDisconnect();
        }, LIVENESS_CHECK_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        if (isStale() || attemptDisposed) return;
        lastServerFrameAt = Date.now();
        if (terminalRef.current) {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'output' && message.data) {
              terminalRef.current.write(message.data);
              setBytesTransferred(prev => ({
                ...prev,
                received: prev.received + message.data.length
              }));
            } else if (message.type === 'error') {
              terminalRef.current.writeln(`\x1b[1;31m${t('remoteTerminal.errorMessage', { message: message.message })}\x1b[0m`);
            } else if (message.type === 'ping') {
              // Respond to server ping to keep connection alive
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
              }
            } else if (message.type === 'connected') {
              // Server has set up the session — now safe to send messages
              serverReady = true;
              setStatus('connected');
              setConnectionTime(new Date());

              // Send initial resize to match actual terminal dimensions
              if (terminalRef.current && ws.readyState === WebSocket.OPEN) {
                const cols = terminalRef.current.cols;
                const rows = terminalRef.current.rows;
                if (cols && rows) {
                  ws.send(JSON.stringify({ type: 'resize', cols, rows }));
                }
              }
            }
          } catch {
            // If not JSON, write raw data (backwards compatibility)
            terminalRef.current.write(event.data);
            setBytesTransferred(prev => ({
              ...prev,
              received: prev.received + event.data.length
            }));
          }
        }
      };

      // Reset the disconnect guard for new connections
      disconnectFiredRef.current = false;
      const callOnDisconnect = () => {
        if (!disconnectFiredRef.current) {
          disconnectFiredRef.current = true;
          onDisconnect?.();
        }
      };

      // A handshake the server refused. Dispose only this attempt and present
      // the retry affordance: the session row and the one-time ticket are both
      // spent, so retrying mints a fresh session and a fresh ticket through the
      // authenticated HTTP endpoints — it never replays this URL.
      const handleRejectedHandshake = () => {
        if (attemptDisposed) return;
        disposeAttempt();
        setStatus('failed');
        setSessionId(null);
        terminalRef.current?.writeln(`\x1b[1;31m${t('remoteTerminal.errors.connection')}\x1b[0m`);
        onError?.(t('remoteTerminal.errors.webSocket'));
        callOnDisconnect();
      };

      ws.onerror = () => {
        if (isStale()) {
          disposeAttempt();
          return;
        }
        if (!opened) {
          handleRejectedHandshake();
          return;
        }
        clearKeepaliveTimers();
        setStatus('failed');
        setSessionId(null);
        terminalRef.current?.writeln(`\x1b[1;31m${t('remoteTerminal.errors.connection')}\x1b[0m`);
        onError?.(t('remoteTerminal.errors.webSocket'));
        callOnDisconnect();
      };

      ws.onclose = (event) => {
        if (isStale()) {
          disposeAttempt();
          return;
        }
        if (!opened) {
          handleRejectedHandshake();
          return;
        }
        clearKeepaliveTimers();
        if (event.code !== 1000) {
          setStatus('failed');
          setSessionId(null);
          terminalRef.current?.writeln(`\x1b[1;31m${t('remoteTerminal.errors.closedUnexpectedly')}\x1b[0m`);
          callOnDisconnect();
        } else {
          setStatus('disconnected');
          setSessionId(null);
          terminalRef.current?.writeln(`\x1b[90m${t('remoteTerminal.sessionEnded')}\x1b[0m`);
          callOnDisconnect();
        }
      };

      // Handle terminal input — only forward after server confirms session
      const dataDisposable = terminalRef.current.onData((data: string) => {
        if (attemptDisposed || isStale()) return;
        if (serverReady && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data }));
          setBytesTransferred(prev => ({
            ...prev,
            sent: prev.sent + data.length
          }));
        }
      });

      // Handle terminal resize — only forward after server confirms session
      const resizeDisposable = terminalRef.current.onResize((size: { cols: number; rows: number }) => {
        if (attemptDisposed || isStale()) return;
        if (serverReady && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'resize',
            cols: size.cols,
            rows: size.rows
          }));
        }
      });

      disposables.push(dataDisposable, resizeDisposable);
      // Store disposables for cleanup
      (ws as unknown as Record<string, unknown>)._disposables = disposables;

      // The handshake may already have been refused while the listeners above
      // were being wired; dispose now rather than leaving them attached.
      if (attemptDisposed || isStale()) {
        disposeAttempt();
      }
    } catch (error) {
      if (isStale()) return;
      setStatus('failed');
      const message = error instanceof Error ? error.message : t('remoteTerminal.errors.failed');
      terminalRef.current?.writeln(`\x1b[1;31m${t('remoteTerminal.errorMessage', { message })}\x1b[0m`);
      onError?.(message);
    }
  }, [deviceId, sessionId, onSessionCreated, onDisconnect, onError, t]);

  // Disconnect from session
  const disconnect = useCallback(async () => {
    // Retire the current attempt so its close/error events cannot re-enter the
    // connection state machine while we tear the session down here.
    connectAttemptRef.current += 1;
    if (webSocketRef.current) {
      const disposables = (webSocketRef.current as unknown as Record<string, unknown[]>)._disposables;
      if (disposables) {
        for (const d of disposables) {
          (d as { dispose: () => void }).dispose();
        }
        // Same array the attempt holds — empty it so the close below can't
        // dispose the listeners a second time.
        disposables.length = 0;
      }
      webSocketRef.current.close(1000);
      webSocketRef.current = null;
    }

    if (sessionId) {
      try {
        await fetchWithAuth(`/remote/sessions/${sessionId}/end`, {
          method: 'POST',
          body: JSON.stringify({
            bytesTransferred: bytesTransferred.sent + bytesTransferred.received
          })
        });
      } catch (error) {
        console.error('Failed to end session:', error);
      }
    }

    setStatus('disconnected');
    // Clear the session id synchronously here rather than relying on the async
    // ws.onclose handler: disconnect() flips status to 'disconnected'
    // immediately (revealing the Reconnect button), so if the user clicks
    // Reconnect before onclose flushes, connect() would otherwise reuse the
    // just-ended sessionId and mint a ws-ticket for a dead session.
    setSessionId(null);
    setConnectionTime(null);
    if (!disconnectFiredRef.current) {
      disconnectFiredRef.current = true;
      onDisconnect?.();
    }
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

  // Initialize terminal on mount. initTerminal has no deps (see above), so
  // this effect's identity never changes across renders and it runs exactly
  // once per real mount/unmount — a deviceHostname/onError/t prop change
  // cannot re-trigger it (issue #4152).
  useEffect(() => {
    initTerminal();

    return () => {
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
      if (webSocketRef.current) {
        webSocketRef.current.close();
        webSocketRef.current = null;
      }
      if (terminalRef.current) {
        terminalRef.current.dispose();
        terminalRef.current = null;
      }
      fitAddonRef.current = null;
      // Reset the one-shot init guard and readiness flag so a genuine
      // remount (a fresh mount of this component, or React StrictMode's
      // dev-mode mount→cleanup→mount on the same instance) can re-init
      // cleanly instead of being permanently blocked by stale guard state.
      initStartedRef.current = false;
      announcedHostnameRef.current = null;
      setTerminalReady(false);
    };
  }, [initTerminal]);

  // The device hostname resolves asynchronously after mount (the page starts
  // with a "Loading device..." placeholder). Once it changes to the real
  // value, update the terminal's "connecting to" line in place rather than
  // re-initializing the terminal — the line is display-only and never
  // affects the guard above.
  useEffect(() => {
    if (!terminalReady || !terminalRef.current) return;
    if (deviceHostname === announcedHostnameRef.current) return;
    terminalRef.current.writeln(`\x1b[90m${t('remoteTerminal.connectingTo', { hostname: deviceHostname })}\x1b[0m`);
    announcedHostnameRef.current = deviceHostname;
  }, [deviceHostname, terminalReady, t]);

  // Auto-connect exactly once, on initial mount. The attempt flag is only set
  // when the timer actually fires (not when scheduled), so an effect re-run
  // caused by a changing `connect` identity during the delay reschedules
  // rather than dropping the initial connection. After this first attempt the
  // terminal never auto-reconnects — a manual Disconnect or a clean session
  // end leaves it disconnected until the user explicitly reconnects (#2137).
  useEffect(() => {
    if (terminalReady && status === 'disconnected' && !sessionId && !autoConnectAttempted) {
      // Small delay to ensure terminal is ready
      const timer = setTimeout(() => {
        setAutoConnectAttempted(true);
        connect();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [terminalReady, status, sessionId, autoConnectAttempted, connect]);

  // The overlay's button has to serve two different broken states. When a
  // session died, the terminal object still exists and reconnecting is the
  // whole job. When init itself failed there is no terminal at all, and
  // connect() early-returns on the null `terminalRef` — so the button silently
  // did nothing (#4152). Re-run init in that case; the auto-connect effect
  // takes it from there once `terminalReady` flips, which is also why the
  // status has to go back to 'disconnected' (that effect is gated on it).
  const handleOverlayRetry = useCallback(() => {
    if (terminalRef.current) {
      void connect();
      return;
    }
    setStatus('disconnected');
    void initTerminal();
  }, [connect, initTerminal]);

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
    if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
    return `${formatNumber(bytes / (1024 * 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
  };

  const StatusIcon = statusConfig[status].icon;

  return (
    <div
      className={cn(
        // flex-1 min-h-0 (#4510): lets the pane grow to fill a flex-column
        // parent's available height (RemoteToolsPage's terminal tab panel)
        // instead of shrinking to the header + the inner 400px floor below.
        // Inert when the parent isn't a flex container (e.g. RemoteTerminalPage,
        // which sizes this via the `className` prop instead).
        'flex flex-1 min-h-0 flex-col rounded-lg border bg-card shadow-xs overflow-hidden',
        isFullscreen && 'fixed inset-4 z-50',
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2">
        <div className="flex items-center gap-3">
          <TerminalIcon className="h-5 w-5 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-semibold">{deviceHostname}</h3>
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
                {t(/* i18n-dynamic */ statusConfig[status].labelKey)}
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
            title={t('remoteTerminal.copySelection')}
          >
            <Copy className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={toggleFullscreen}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            title={isFullscreen ? t('remoteTerminal.exitFullscreen') : t('remoteTerminal.fullscreen')}
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
              {t('remoteTerminal.disconnect')}
            </button>
          ) : null}
          {/* The retry/reconnect affordance lives in the disconnect overlay
              below (#2871) — a dead session must be unmissable, and a single
              button avoids duplicate controls for the same action. */}
        </div>
      </div>

      {/* Terminal Container */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <div
          ref={terminalContainerRef}
          className="flex-1 min-h-0 u-min-h-px-400 bg-[#1a1b26] text-[#f8f8f2] cursor-text p-2 overflow-hidden"
          onClick={() => terminalRef.current?.focus()}
        />
        {/* Disconnect overlay (issue #2871): a dead session must be unmissable,
            not a silent freeze. Shown for any post-connect terminal state that
            is no longer live, with an explicit reconnect affordance. The
            container is pointer-events-none (only the inner panel captures
            clicks) so the scrollback behind it stays selectable/copyable, and
            only a genuine failure dims the transcript. */}
        {(status === 'failed' || (status === 'disconnected' && autoConnectAttempted)) && (
          <div
            data-testid="terminal-disconnect-overlay"
            className={cn(
              'pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center',
              status === 'failed' && 'bg-black/40'
            )}
          >
            <div className="pointer-events-auto flex flex-col items-center gap-3 rounded-lg bg-black/80 px-6 py-4">
              <WifiOff className="h-8 w-8 text-red-400" />
              <span className="text-sm font-medium text-white">
                {t(/* i18n-dynamic */ statusConfig[status].labelKey)}
              </span>
              <button
                type="button"
                data-testid="terminal-overlay-reconnect"
                onClick={handleOverlayRetry}
                className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                <RefreshCw className="h-4 w-4" />
                {status === 'failed' ? t('common:actions.retry') : t('remoteTerminal.reconnect')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
