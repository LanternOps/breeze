import { useEffect, useRef, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { type ConnectionParams } from '../lib/protocol';
import { exchangeDesktopConnectCode } from '../lib/api';
import { scaleVideoCoords, AgentSessionError, type AuthenticatedConnectionParams } from '../lib/webrtc';
import { connectWebRTC as connectWebRTCTransport, type WebRTCSessionWrapper } from '../lib/transports/webrtc';
import { connectWebSocket as connectWebSocketTransport, type WebSocketSessionWrapper } from '../lib/transports/websocket';
// VncSessionWrapper is type-only — no runtime import (avoids bundling novnc into the main chunk).
// connectVnc is loaded dynamically inside connectVncTransport so novnc's top-level await
// is deferred until the VNC path is actually invoked.
import type { VncSessionWrapper } from '../lib/transports/vnc';
import { createVncTunnel, closeTunnel } from '../lib/tunnel';
import { pollDesktopAccess } from '../lib/desktopAccess';
import { mapKey, getModifiers, isModifierOnly } from '../lib/keymap';
import { textToKeyEvents } from '../lib/paste';
import { DEFAULT_WHEEL_ACCUMULATOR, wheelDeltaToSteps } from '../lib/wheel';
import { handleCtrlVPaste } from '../lib/clipboardPaste';
import ViewerToolbar from './ViewerToolbar';
import CredentialsPromptModal from './CredentialsPromptModal';

interface Props {
  params: ConnectionParams;
  onDisconnect: () => void;
  onError: (msg: string) => void;
}

type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';
type Transport = 'webrtc' | 'websocket' | 'vnc';

const RECONNECT_TIMEOUT_MS = 30_000;
const RECONNECT_INTERVAL_MS = 3_000;

export default function DesktopViewer({ params, onDisconnect, onError }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const wsRef = useRef<WebSocketSessionWrapper | null>(null);
  const webrtcRef = useRef<WebRTCSessionWrapper | null>(null);
  const transportRef = useRef<Transport | null>(null);
  const wsCleanupRef = useRef<(() => void) | null>(null);
  const authRef = useRef<AuthenticatedConnectionParams | null>(null);
  const cancelledRef = useRef(false);
  const webrtcFallbackAttemptedRef = useRef(false);
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const wheelAccRef = useRef(DEFAULT_WHEEL_ACCUMULATOR);
  const pasteCancelRef = useRef(false);
  const userDisconnectRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectDeadlineRef = useRef<number | null>(null);
  const reconnectInFlightRef = useRef(false);
  const startReconnectRef = useRef<() => void>(() => {});
  const switchTransportRef = useRef<(target: Transport) => Promise<void>>(async () => {});
  const sessionRegisteredRef = useRef(false);

  // VNC session + tunnel lifecycle
  const vncContainerRef = useRef<HTMLDivElement>(null);
  const vncSessionRef = useRef<VncSessionWrapper | null>(null);
  const activeVncTunnelIdRef = useRef<string | null>(null);
  const switchingToRef = useRef<Transport | null>(null);

  const clipboardDCRef = useRef<RTCDataChannel | null>(null);
  const lastClipboardHashRef = useRef<string>('');
  const clipboardAckMapRef = useRef<Map<string, { resolve: () => void; timer: ReturnType<typeof setTimeout> }>>(new Map());
  const webrtcMouseMovePendingRef = useRef<{ x: number; y: number } | null>(null);
  const webrtcMouseMoveRafRef = useRef<number | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [reconnectSecondsLeft, setReconnectSecondsLeft] = useState(0);
  const [transport, setTransport] = useState<Transport | null>(null);
  const [fps, setFps] = useState(0);
  const [quality, setQuality] = useState(60);
  const [scale, setScale] = useState(1.0);
  const [maxFps, setMaxFps] = useState(60);
  const [bitrate, setBitrate] = useState(2500);
  const [hostname, setHostname] = useState('');
  const [remoteOs, setRemoteOs] = useState<string | null>(null);
  const [connectedAt, setConnectedAt] = useState<Date | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pasteProgress, setPasteProgress] = useState<{ current: number; total: number } | null>(null);
  const [remapCmdCtrl, setRemapCmdCtrl] = useState(true);
  const [cursorStreamActive, setCursorStreamActive] = useState(false);
  const [monitors, setMonitors] = useState<Array<{ index: number; name: string; width: number; height: number; isPrimary: boolean }>>([]);
  const [activeMonitor, setActiveMonitor] = useState(0);
  const [sessions, setSessions] = useState<Array<{ sessionId: number; username: string; state: string; type: string; helperConnected: boolean }>>([]);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(
    params.mode === 'desktop' ? (params.targetSessionId ?? null) : null
  );
  const [switchingSession, setSwitchingSession] = useState<string | null>(null);
  const switchingSessionRef = useRef(false);
  // VNC / transport-switcher state
  const [switchingTo, setSwitchingTo] = useState<Transport | null>(null);
  const [desktopState, setDesktopState] = useState<{ state: 'loginwindow' | 'user_session' | null; username: string | null }>({ state: null, username: null });
  const [webRTCAvailable, setWebRTCAvailable] = useState(false);
  const [remoteUserName, setRemoteUserName] = useState<string | null>(null);
  const [credentialsPrompt, setCredentialsPrompt] = useState<{ requiresUsername: boolean; submit: (creds: { username?: string; password: string }) => void } | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [hasAudioTrack, setHasAudioTrack] = useState(false);
  const [showRemoteCursor, setShowRemoteCursor] = useState(false);
  const cursorOverlayRef = useRef<HTMLDivElement>(null);
  const showRemoteCursorRef = useRef(false);
  // Tracks the current remote cursor CSS shape (e.g. "default", "pointer", "text").
  // Updated from the cursor data channel; applied to the video element style.
  const remoteCursorShapeRef = useRef<string>('default');

  const setTransportState = useCallback((t: Transport | null) => {
    transportRef.current = t;
    setTransport(t);
  }, []);

  // ── VNC connect helper ─────────────────────────────────────────────

  const connectVncTransport = useCallback(async (tunnel: { tunnelId: string; wsUrl: string }): Promise<boolean> => {
    const container = vncContainerRef.current;
    if (!container) return false;

    try {
      // Lazy-load the VNC transport so novnc (which uses top-level await) is only
      // bundled into a separate async chunk and doesn't land in the main bundle.
      const { connectVnc } = await import('../lib/transports/vnc');
      const session = await connectVnc(tunnel, {
        container,
        onStatus: (s) => {
          if (s === 'connecting') setStatus('connecting');
          else if (s === 'connected') {
            setStatus('connected');
            setConnectedAt(new Date());
            setErrorMessage(null);
          } else if (s === 'disconnected') {
            setStatus('disconnected');
            setConnectedAt(null);
          } else if (s === 'error') {
            setStatus('error');
            setConnectedAt(null);
          }
        },
        onError: setErrorMessage,
        onCredentialsRequired: (requiresUsername, submit) => {
          setCredentialsPrompt({ requiresUsername, submit });
        },
      });
      vncSessionRef.current = session;
      setTransportState('vnc');
      return true;
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'VNC connect failed');
      return false;
    }
  }, [setTransportState]);

  useEffect(() => {
    showRemoteCursorRef.current = showRemoteCursor;
    if (!showRemoteCursor && cursorOverlayRef.current) {
      cursorOverlayRef.current.style.display = 'none';
    }
    // When switching between cursor modes, update the video element's CSS cursor.
    // In overlay mode the local cursor is hidden; otherwise show the remote shape.
    const videoEl = videoRef.current;
    if (videoEl) {
      if (showRemoteCursor) {
        videoEl.style.cursor = 'none';
      } else {
        videoEl.style.cursor = remoteCursorShapeRef.current || 'default';
      }
    }
  }, [showRemoteCursor]);

  // Frame rate tracking
  const frameCountRef = useRef(0);
  const fpsIntervalRef = useRef<ReturnType<typeof setInterval>>();

  // Remote screen size (actual pixels from agent)
  const remoteScreenRef = useRef({ width: 1920, height: 1080 });

  // WebSocket JPEG decode backpressure: keep at most one decode in-flight and
  // always prefer the latest pending frame.
  const jpegDecodeInFlightRef = useRef(false);
  const jpegPendingFrameRef = useRef<ArrayBuffer | null>(null);
  // renderFrame is defined after connectWebSocket; use a ref to break the TDZ.
  const renderFrameRef = useRef<(data: ArrayBuffer) => void>(() => {});

  // ── Transport switcher ─────────────────────────────────────────────
  // Forward-declared ref so switchTransport can call connectWebRTC before
  // connectWebRTC is defined in this scope (they are mutually recursive via
  // auto-handoff).  The ref is kept in sync below after connectWebRTC is defined.
  const connectWebRTCRef = useRef<(auth: AuthenticatedConnectionParams, targetSessionId?: number) => Promise<boolean>>(async () => false);

  const switchTransport = useCallback(async (target: Transport) => {
    if (switchingToRef.current !== null) {
      // Another switch is in progress — don't start a competing one.
      return;
    }
    if (transportRef.current === target) return;
    const auth = authRef.current;
    if (!auth) return;

    // Stop any pending reconnect so attemptReconnect can't fire mid-switch.
    if (reconnectTimerRef.current) {
      clearInterval(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectDeadlineRef.current = null;
    setReconnectSecondsLeft(0);
    reconnectInFlightRef.current = false;
    setCredentialsPrompt(null);

    switchingToRef.current = target;
    setSwitchingTo(target);
    setStatus('connecting');

    // Tear down current VNC session + tunnel before switching
    const prevVnc = vncSessionRef.current;
    vncSessionRef.current = null;
    prevVnc?.close();
    if (activeVncTunnelIdRef.current) {
      const tunnelId = activeVncTunnelIdRef.current;
      activeVncTunnelIdRef.current = null;
      void closeTunnel(tunnelId, { apiUrl: auth.apiUrl, accessToken: auth.accessToken });
    }

    // Tear down current WebRTC session
    if (webrtcMouseMoveRafRef.current !== null) {
      cancelAnimationFrame(webrtcMouseMoveRafRef.current);
      webrtcMouseMoveRafRef.current = null;
    }
    webrtcMouseMovePendingRef.current = null;
    const prevRtc = webrtcRef.current;
    webrtcRef.current = null;
    prevRtc?.close();

    // Tear down WebSocket
    wsCleanupRef.current?.();
    wsCleanupRef.current = null;

    setTransportState(null);

    try {
      if (target === 'vnc') {
        if (!auth.deviceId) throw new Error('deviceId required for VNC switch');
        const tunnel = await createVncTunnel(auth.deviceId, { apiUrl: auth.apiUrl, accessToken: auth.accessToken });
        activeVncTunnelIdRef.current = tunnel.tunnelId;
        const ok = await connectVncTransport(tunnel);
        if (!ok) throw new Error('VNC connect failed');
      } else if (target === 'webrtc') {
        setWebRTCAvailable(false);
        const ok = await connectWebRTCRef.current(auth);
        if (!ok) throw new Error('WebRTC connect failed');
      }
      // websocket switching not wired here — only webrtc/vnc are in the switcher
    } catch (err) {
      setErrorMessage(`Failed to switch to ${target}: ${err instanceof Error ? err.message : String(err)}`);
      setStatus('error');
    } finally {
      switchingToRef.current = null;
      setSwitchingTo(null);
    }
  }, [connectVncTransport, setTransportState]);

  // ── WebRTC connection ──────────────────────────────────────────────

  const connectWebRTC = useCallback(async (auth: AuthenticatedConnectionParams, targetSessionId?: number): Promise<boolean> => {
    const videoEl = videoRef.current;
    if (!videoEl) return false;

    const sessionWrapper = await connectWebRTCTransport(auth, {
      videoElement: videoEl,
      cursorOverlayRef,
      targetSessionId: targetSessionId ?? (params.mode === 'desktop' ? params.targetSessionId : undefined),
      showRemoteCursorRef,
      remoteCursorShapeRef,
      onConnected: () => {
        // Guard: ignore stale session events after the ref has moved on
        if (webrtcRef.current !== sessionWrapper) return;
        setStatus('connected');
        setConnectedAt(new Date());
        setErrorMessage(null);
        // Ensure keyboard input is captured without an extra click.
        videoRef.current?.focus();
      },
      onDisconnected: () => {
        if (webrtcRef.current !== sessionWrapper) return;
        if (userDisconnectRef.current) return;
        startReconnectRef.current();
      },
      onFailed: () => {
        if (webrtcRef.current !== sessionWrapper) return;
        if (userDisconnectRef.current) return;
        startReconnectRef.current();
      },
      onClosed: () => {
        if (webrtcRef.current !== sessionWrapper) return;
        if (userDisconnectRef.current) return;
        setStatus('disconnected');
        setConnectedAt(null);
      },
      onAudioTrack: (audioEl) => {
        audioElRef.current = audioEl;
        setHasAudioTrack(true);
      },
      onClipboardChannel: (channel) => {
        clipboardDCRef.current = channel;
        channel.onmessage = (msg) => {
          try {
            const payload = JSON.parse(msg.data);
            if (payload.type === 'ack' && payload.hash) {
              const entry = clipboardAckMapRef.current.get(payload.hash);
              if (entry) {
                clearTimeout(entry.timer);
                clipboardAckMapRef.current.delete(payload.hash);
                entry.resolve();
              } else {
                console.debug('[clipboard] ack for unknown hash:', payload.hash);
              }
            } else if (payload.type === 'text' && payload.text) {
              lastClipboardHashRef.current = payload.text;
              // navigator.clipboard.writeText requires a user activation in
              // WKWebView/WebView2; invoking it from an onmessage handler
              // silently rejects with NotAllowedError. Route through the
              // Tauri plugin, which goes via the Rust side and does not
              // require a gesture.
              import('@tauri-apps/plugin-clipboard-manager').then(({ writeText }) =>
                writeText(payload.text)
              ).catch((err) => {
                console.warn('[clipboard] failed to write remote→local:', err);
              });
            }
          } catch (err) {
            console.warn('[clipboard] message handling failed:', err);
          }
        };
        channel.onclose = () => {
          clipboardDCRef.current = null;
          for (const entry of clipboardAckMapRef.current.values()) {
            clearTimeout(entry.timer);
            entry.resolve();
          }
          clipboardAckMapRef.current.clear();
        };
      },
      onCursorChannelOpen: () => setCursorStreamActive(true),
      onCursorChannelClose: () => setCursorStreamActive(false),
    });

    if (!sessionWrapper) return false;

    webrtcRef.current = sessionWrapper;

    // Reduce input lag under loss: coalesce mouse moves, avoid unbounded buffering.
    try {
      sessionWrapper.inputChannel.onbufferedamountlow = () => {
        if (webrtcMouseMovePendingRef.current && webrtcMouseMoveRafRef.current === null) {
          webrtcMouseMoveRafRef.current = requestAnimationFrame(flushWebRTCMouseMove);
        }
      };
    } catch {
      // Some environments may not support onbufferedamountlow.
    }

    setTransportState('webrtc');
    // Hostname is already set from the exchange response before connectWebRTC is called.
    // Connection state will flip to 'connected' via onConnected callback.
    return true;
  }, [params.mode === 'desktop' ? params.targetSessionId : undefined]);

  // Keep the forward ref in sync so switchTransport can call the latest version.
  connectWebRTCRef.current = connectWebRTC;

  // ── WebSocket connection (fallback) ────────────────────────────────

  const connectWebSocket = useCallback(async (auth: AuthenticatedConnectionParams) => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return null;

    const sessionWrapper = await connectWebSocketTransport(auth, {
      canvasElement: canvasEl,
      onConnected: ({ hostname: deviceHostname, osType }) => {
        if (wsRef.current !== sessionWrapper) return;
        setStatus('connected');
        setHostname(deviceHostname);
        if (osType) setRemoteOs(osType);
        invoke('update_session_hostname', { hostname: deviceHostname }).catch((err) => {
          console.warn('Failed to update session hostname:', err);
        });
        setConnectedAt(new Date());
        setErrorMessage(null);
        canvasRef.current?.focus();
      },
      onDisconnected: () => {
        if (wsRef.current !== sessionWrapper) return;
        setConnectedAt(null);
        if (!userDisconnectRef.current) {
          startReconnectRef.current();
        } else {
          setStatus('disconnected');
        }
      },
      onError: (message) => {
        if (wsRef.current !== sessionWrapper) return;
        setStatus('error');
        setConnectedAt(null);
        setErrorMessage(message);
        onError(message);
      },
      onFrame: (data) => renderFrameRef.current(data),
    });

    if (!sessionWrapper) {
      setStatus('error');
      setErrorMessage('Failed to create connection ticket');
      onError('Failed to create connection ticket');
      return null;
    }

    wsRef.current = sessionWrapper;
    wsCleanupRef.current = () => {
      wsRef.current = null;
      wsCleanupRef.current = null;
      sessionWrapper.close();
    };

    setTransportState('websocket');

    return wsCleanupRef.current;
  }, [onError]);

  // ── Reconnect logic (refs to break circular deps with hooks defined later) ──

  const stopReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearInterval(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectDeadlineRef.current = null;
    setReconnectSecondsLeft(0);
  }, []);

  // releaseAllKeys is defined after sendInputFn; use ref to break TDZ
  const releaseAllKeysRef = useRef<() => void>(() => {});

  const attemptReconnect = useCallback(async () => {
    const auth = authRef.current;
    if (!auth || cancelledRef.current || userDisconnectRef.current) {
      stopReconnect();
      return;
    }
    if (reconnectInFlightRef.current) return;
    if (switchingToRef.current !== null) {
      // A transport switch is in progress — skip this reconnect tick.
      // The switch will either install a new session or restore the previous.
      return;
    }

    // Check deadline
    const deadline = reconnectDeadlineRef.current;
    if (!deadline || Date.now() >= deadline) {
      stopReconnect();
      // Auto-handoff to VNC on macOS when WebRTC reconnect times out
      const remoteOsSnap = remoteOs;
      if (remoteOsSnap === 'macos' && auth.deviceId && transportRef.current !== 'vnc') {
        void switchTransportRef.current('vnc');
        return;
      }
      setStatus('disconnected');
      setConnectedAt(null);
      setErrorMessage('Reconnection timed out');
      return;
    }

    setReconnectSecondsLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));

    // Tear down old connections
    releaseAllKeysRef.current();
    if (webrtcMouseMoveRafRef.current !== null) {
      cancelAnimationFrame(webrtcMouseMoveRafRef.current);
      webrtcMouseMoveRafRef.current = null;
    }
    webrtcMouseMovePendingRef.current = null;
    wsCleanupRef.current?.();
    wsCleanupRef.current = null;
    const oldRtc = webrtcRef.current;
    webrtcRef.current = null;
    oldRtc?.close();

    reconnectInFlightRef.current = true;
    const originalTransport = transportRef.current;
    if (!originalTransport) {
      console.warn('Reconnect: transport ref was null, defaulting to WebRTC');
    }
    try {
      if (originalTransport === 'websocket') {
        // Original connection was WebSocket — reconnect with WS only
        const cleanup = await connectWebSocket(auth);
        if (cancelledRef.current || userDisconnectRef.current) {
          cleanup?.();
          return;
        }
        if (cleanup) {
          wsCleanupRef.current = cleanup;
          stopReconnect();
        }
      } else {
        // Original connection was WebRTC (or unknown) — reconnect with WebRTC only
        const webrtcOk = await connectWebRTC(auth);
        if (cancelledRef.current || userDisconnectRef.current) return;

        if (webrtcOk) {
          stopReconnect();
        }
        // If WebRTC fails, let the interval retry — don't fall back to WS
      }
    } catch (err) {
      if (err instanceof AgentSessionError) {
        stopReconnect();
        setStatus('error');
        setConnectedAt(null);
        setErrorMessage(err.message);
        onError(err.message);
        reconnectInFlightRef.current = false;
        return;
      }
      console.warn('Reconnect attempt failed (will retry):', err);
    } finally {
      reconnectInFlightRef.current = false;
    }
  }, [connectWebRTC, connectWebSocket, stopReconnect, remoteOs]);

  const startReconnect = useCallback(() => {
    if (!authRef.current || userDisconnectRef.current) return;

    // Don't start if already reconnecting
    if (reconnectTimerRef.current) return;

    setStatus('reconnecting');
    const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
    reconnectDeadlineRef.current = deadline;
    setReconnectSecondsLeft(Math.ceil(RECONNECT_TIMEOUT_MS / 1000));

    // First attempt immediately
    void attemptReconnect();

    // Then retry every interval
    reconnectTimerRef.current = setInterval(() => {
      void attemptReconnect();
    }, RECONNECT_INTERVAL_MS);
  }, [attemptReconnect]);

  // Keep refs in sync so callbacks inside earlier useCallback closures use the latest version
  startReconnectRef.current = startReconnect;
  switchTransportRef.current = switchTransport;

  // ── Connection lifecycle ───────────────────────────────────────────

  useEffect(() => {
    // Per-invocation cancel flag. Using a local variable (not the shared ref)
    // ensures that when params change, the OLD connect() sees cancelled=true
    // even after the NEW effect body resets cancelledRef for its own connect().
    let cancelled = false;
    cancelledRef.current = false;
    webrtcFallbackAttemptedRef.current = false;
    userDisconnectRef.current = false;
    reconnectInFlightRef.current = false;
    authRef.current = null;
    wheelAccRef.current = DEFAULT_WHEEL_ACCUMULATOR;
    setCursorStreamActive(false);

    // Kill any stale reconnect timer from a previous session (e.g. when
    // App.tsx replaces params via a new deep link while reconnecting).
    stopReconnect();

    // Ensure any previous transport is fully torn down before connecting.
    releaseAllKeys();
    wsCleanupRef.current?.();
    wsCleanupRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    // Null ref before close to prevent stale onconnectionstatechange handlers
    const prevWebrtc = webrtcRef.current;
    webrtcRef.current = null;
    prevWebrtc?.close();

    setStatus('connecting');
    setTransportState(null);
    setHostname('');
    setConnectedAt(null);
    setErrorMessage(null);

    async function connect() {
      // VNC deep link — bypass connect-code exchange, use credentials from the URL directly.
      if (params.mode === 'vnc') {
        authRef.current = {
          sessionId: '',
          apiUrl: params.apiUrl,
          accessToken: params.accessToken,
          deviceId: params.deviceId,
        };
        setRemoteOs('macos'); // VNC is macOS-only for now
        activeVncTunnelIdRef.current = params.tunnelId;
        const ok = await connectVncTransport({ tunnelId: params.tunnelId, wsUrl: params.wsUrl });
        if (cancelled) return;
        if (!ok) {
          setStatus('error');
          onError('Failed to start VNC session');
        }
        return;
      }

      // Desktop connect-code flow
      try {
        const exchange = await exchangeDesktopConnectCode(
          params.apiUrl,
          params.sessionId,
          params.connectCode
        );
        if (cancelled) return;

        if (!exchange?.accessToken) {
          setStatus('error');
          setErrorMessage('Invalid or expired connection code');
          setConnectedAt(null);
          onError('Invalid or expired connection code');
          return;
        }

        const authParams: AuthenticatedConnectionParams = {
          sessionId: params.sessionId,  // narrowed: params.mode === 'desktop' guard above
          apiUrl: params.apiUrl,
          accessToken: exchange.accessToken,
          ...(params.deviceId ? { deviceId: params.deviceId } : {}),
        };
        authRef.current = authParams;

        // Set hostname + OS from exchange response (available for all transports)
        if (exchange.hostname) {
          setHostname(exchange.hostname);
          // Window title set from Rust in update_session_hostname
          invoke('update_session_hostname', { hostname: exchange.hostname }).catch((err) => {
            console.warn('Failed to update session hostname:', err);
          });
        }
        if (exchange.osType) {
          setRemoteOs(exchange.osType);
        }

        // Try WebRTC first
        const webrtcOk = await connectWebRTC(authParams);
        if (cancelled) {
          webrtcRef.current?.close();
          webrtcRef.current = null;
          return;
        }

        if (!webrtcOk) {
          // Fall back to WebSocket
          const cleanup = await connectWebSocket(authParams);
          if (cancelled) {
            cleanup?.();
            return;
          }
          wsCleanupRef.current = cleanup;
        }
      } catch (err) {
        if (cancelled) return;
        console.error('Remote desktop connect failed:', err);
        const msg = err instanceof Error ? err.message : 'Connection failed';
        setStatus('error');
        setErrorMessage(msg);
        setConnectedAt(null);
        onError(msg);
      }
    }

    connect();

    // FPS counter
    fpsIntervalRef.current = setInterval(() => {
      setFps(frameCountRef.current);
      frameCountRef.current = 0;
    }, 1000);

    return () => {
      cancelled = true;
      cancelledRef.current = true;
      stopReconnect();
      reconnectInFlightRef.current = false;

      // Best-effort: release keys before closing the transport.
      releaseAllKeys();

      if (webrtcMouseMoveRafRef.current !== null) {
        cancelAnimationFrame(webrtcMouseMoveRafRef.current);
        webrtcMouseMoveRafRef.current = null;
      }
      webrtcMouseMovePendingRef.current = null;

      clearInterval(fpsIntervalRef.current);
      wsCleanupRef.current?.();
      wsCleanupRef.current = null;
      // Null the ref BEFORE close() so the onconnectionstatechange guard
      // (webrtcRef.current !== session) catches any synchronous state
      // change events and prevents stale reconnect triggers.
      const oldWebrtc = webrtcRef.current;
      webrtcRef.current = null;
      oldWebrtc?.close();

      // Close VNC session and tunnel on unmount
      const oldVnc = vncSessionRef.current;
      vncSessionRef.current = null;
      oldVnc?.close();
      if (activeVncTunnelIdRef.current) {
        const tunnelId = activeVncTunnelIdRef.current;
        activeVncTunnelIdRef.current = null;
        const auth = authRef.current;
        if (auth) {
          void closeTunnel(tunnelId, { apiUrl: auth.apiUrl, accessToken: auth.accessToken });
        }
      }

      for (const entry of clipboardAckMapRef.current.values()) {
        clearTimeout(entry.timer);
        entry.resolve();
      }
      clipboardAckMapRef.current.clear();

	      if (sessionRegisteredRef.current) {
	        sessionRegisteredRef.current = false;
	        invoke('unregister_session').catch((err) => {
	          console.error('Failed to unregister desktop session on unmount:', err);
	        });
	      }
	    };
	  }, [connectWebRTC, connectWebSocket, connectVncTransport, onError, params, stopReconnect]);

  // Mark a window as "session active" only when fully connected.
  // Pass session_id so Rust can detect duplicate deep links for the same session.
	  useEffect(() => {
	    if (status === 'connected' && !sessionRegisteredRef.current) {
	      sessionRegisteredRef.current = true;
	      if (params.mode === 'desktop') {
	        invoke('register_session', { sessionId: params.sessionId }).catch((err) => {
	          console.error('Failed to register desktop session:', err);
	        });
	        if (params.deviceId) {
	          invoke('register_device', { deviceId: params.deviceId }).catch((err) => {
	            console.error('Failed to register desktop device:', err);
	          });
	        }
	      } else {
	        // VNC mode: register by deviceId; Task 3.5 adds full VNC session registration
	        invoke('register_device', { deviceId: params.deviceId }).catch((err) => {
	          console.error('Failed to register vnc device:', err);
	        });
	      }
	      return;
	    }
	    if (status !== 'connected' && status !== 'reconnecting' && sessionRegisteredRef.current) {
	      sessionRegisteredRef.current = false;
	      invoke('unregister_session').catch((err) => {
	        console.error('Failed to unregister desktop session:', err);
	      });
	    }
	  }, [status, params]);

  // Count WebRTC video frames via requestVideoFrameCallback
  useEffect(() => {
    if (transport !== 'webrtc') return;
    const videoEl = videoRef.current;
    if (!videoEl) return;

    let active = true;

    const rvfc = (videoEl as unknown as { requestVideoFrameCallback?: (cb: () => void) => number })
      .requestVideoFrameCallback;

    if (typeof rvfc === 'function') {
      const onFrame = () => {
        if (!active) return;
        frameCountRef.current++;
        rvfc.call(videoEl, onFrame);
      };
      rvfc.call(videoEl, onFrame);
      return () => { active = false; };
    }

    // Fallback: approximate frames by watching currentTime advance.
    let lastTime = videoEl.currentTime;
    const tick = () => {
      if (!active) return;
      const t = videoEl.currentTime;
      if (t !== lastTime) {
        lastTime = t;
        frameCountRef.current++;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { active = false; };
  }, [transport]);

  // Request a keyframe when the viewer window/tab regains focus so the
  // picture is immediately sharp (avoids stale/artifact-y decoded frames).
  useEffect(() => {
    if (transport !== 'webrtc') return;
    const onFocus = () => {
      const ch = webrtcRef.current?.controlChannel;
      if (ch && ch.readyState === 'open') {
        ch.send(JSON.stringify({ type: 'request_keyframe' }));
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') onFocus();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [transport]);

  // WebRTC stats polling — reports ICE candidate pair, RTT, jitter, and packet
  // loss every 5s. Sends stats to the agent via the control channel so they ship
  // through the agent's log pipeline to the database. Also logs to console.
  useEffect(() => {
    if (transport !== 'webrtc') return;
    const pc = webrtcRef.current?.pc;
    const ch = webrtcRef.current?.controlChannel;
    if (!pc) return;

    let prevBytesReceived = 0;
    let prevTimestamp = 0;
    let prevPacketsLost = 0;
    let prevPacketsReceived = 0;
    let prevFramesDropped = 0;
    const interval = setInterval(async () => {
      try {
        const stats = await pc.getStats();
        let rttMs = 0;
        let localType = '', remoteType = '', protocol = '';
        let framesReceived = 0, framesDecoded = 0, framesDropped = 0;
        let jitterMs = 0, packetsLost = 0, packetsReceived = 0, kbps = 0;

        stats.forEach((report: Record<string, unknown>) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            rttMs = typeof report.currentRoundTripTime === 'number'
              ? Math.round(report.currentRoundTripTime * 1000) : 0;
            const localId = report.localCandidateId as string;
            const remoteId = report.remoteCandidateId as string;
            stats.forEach((r: Record<string, unknown>) => {
              if (r.id === localId) { localType = r.candidateType as string; protocol = r.protocol as string; }
              if (r.id === remoteId) { remoteType = r.candidateType as string; }
            });
          }
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            const bytesNow = (report.bytesReceived as number) || 0;
            const tsNow = (report.timestamp as number) || 0;
            if (prevTimestamp > 0 && tsNow > prevTimestamp) {
              kbps = Math.round(((bytesNow - prevBytesReceived) * 8) / (tsNow - prevTimestamp));
            }
            prevBytesReceived = bytesNow;
            prevTimestamp = tsNow;
            framesReceived = (report.framesReceived as number) ?? 0;
            framesDecoded = (report.framesDecoded as number) ?? 0;
            framesDropped = (report.framesDropped as number) ?? 0;
            jitterMs = typeof report.jitter === 'number' ? Math.round(report.jitter * 1000) : 0;
            packetsLost = (report.packetsLost as number) ?? 0;
            packetsReceived = (report.packetsReceived as number) ?? 0;
          }
        });

        const summary = `local=${localType}/${protocol} remote=${remoteType} rtt=${rttMs}ms | frames=${framesReceived} decoded=${framesDecoded} dropped=${framesDropped} jitter=${jitterMs}ms pktLost=${packetsLost} kbps=${kbps}`;
        console.log(`[WebRTC stats] ${summary}`);

        // Send to agent via control channel so stats appear in agent_logs
        // and drive the adaptive bitrate controller.
        if (ch && ch.readyState === 'open') {
          ch.send(JSON.stringify({
            type: 'viewer_stats',
            rttMs,
            jitterMs,
            packetsLost,
            packetsLostDelta: packetsLost - prevPacketsLost,
            packetsReceived,
            packetsReceivedDelta: packetsReceived - prevPacketsReceived,
            framesReceived,
            framesDecoded,
            framesDropped,
            framesDroppedDelta: framesDropped - prevFramesDropped,
            kbps,
            iceLocal: `${localType}/${protocol}`,
            iceRemote: remoteType,
          }));
        }
        prevPacketsLost = packetsLost;
        prevPacketsReceived = packetsReceived;
        prevFramesDropped = framesDropped;
      } catch {
        // pc might be closed
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [transport]);

  // Request monitor list and listen for control channel responses (WebRTC only)
	  useEffect(() => {
	    if (transport !== 'webrtc') return;
	    const ch = webrtcRef.current?.controlChannel;
	    if (!ch) return;

	    const onOpen = () => {
	      ch.send(JSON.stringify({ type: 'list_monitors' }));
	      ch.send(JSON.stringify({ type: 'list_sessions' }));
	    };
    const onMessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
          case 'monitors':
            if (Array.isArray(msg.monitors)) setMonitors(msg.monitors);
            break;
          case 'sessions':
            if (Array.isArray(msg.sessions)) setSessions(msg.sessions);
            break;
          case 'monitor_switched':
            setActiveMonitor(msg.index ?? 0);
            // Request a keyframe so the browser decoder gets a fresh IDR
            // with the new resolution's SPS/PPS immediately.
            ch.send(JSON.stringify({ type: 'request_keyframe' }));
            break;
          case 'sas_result':
            if (!msg.ok) console.warn('SAS failed:', msg.error);
            if (msg.ok && msg.verificationSupported && !msg.verified) {
              console.warn('SAS request was sent but secure-desktop transition was not observed');
            }
            break;
          case 'lock_result':
            if (!msg.ok) console.warn('Lock workstation failed:', msg.error);
            break;
          case 'desktop_state':
            setDesktopState({ state: msg.state ?? null, username: msg.username ?? null });
            if (
              msg.state === 'loginwindow' &&
              remoteOs === 'macos' &&
              authRef.current?.deviceId &&
              transportRef.current !== 'vnc'
            ) {
              stopReconnect();
              setCredentialsPrompt(null);
              void switchTransportRef.current?.('vnc');
            }
            break;
        }
      } catch (err) {
        console.warn('Failed to parse control message:', err);
      }
    };

    if (ch.readyState === 'open') {
      onOpen();
    }
    ch.addEventListener('open', onOpen);
    ch.addEventListener('message', onMessage);

    const sessionPollInterval = setInterval(() => {
      if (ch.readyState === 'open') {
        ch.send(JSON.stringify({ type: 'list_sessions' }));
      }
    }, 30_000);

	    return () => {
	      ch.removeEventListener('open', onOpen);
	      ch.removeEventListener('message', onMessage);
	      clearInterval(sessionPollInterval);
	    };
	  }, [transport]);

  // Keep agent cursor streaming in sync with the local Remote Cursor toggle.
  useEffect(() => {
    if (transport !== 'webrtc') return;
    const ch = webrtcRef.current?.controlChannel;
    if (!ch) return;
    const syncCursorStream = () => {
      if (ch.readyState !== 'open') return;
      ch.send(JSON.stringify({ type: 'set_cursor_stream', value: showRemoteCursor ? 1 : 0 }));
    };
    syncCursorStream();
    ch.addEventListener('open', syncCursorStream);
    return () => {
      ch.removeEventListener('open', syncCursorStream);
    };
  }, [showRemoteCursor, transport]);

  // ── Desktop-access polling (VNC + macOS only) ──────────────────────
  // While connected via VNC, poll every 5s to check if WebRTC has become
  // available again (e.g. user logged back in). Surfaces to toolbar via
  // webRTCAvailable + remoteUserName state.
  useEffect(() => {
    if (transport !== 'vnc' || remoteOs !== 'macos' || status !== 'connected') return;
    const auth = authRef.current;
    if (!auth?.deviceId) return;

    let cancelled = false;
    const deviceId = auth.deviceId;

    const pollOnce = async () => {
      const snap = await pollDesktopAccess(deviceId, { apiUrl: auth.apiUrl, accessToken: auth.accessToken });
      if (cancelled || !snap) return;
      setWebRTCAvailable(snap.webRTCAvailable);
      setRemoteUserName(snap.username);
    };

    void pollOnce();
    const interval = setInterval(pollOnce, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [transport, remoteOs, status]);

  // ── Frame rendering (WebSocket JPEG path) ──────────────────────────

  const processJpegFrames = useCallback(async () => {
    if (jpegDecodeInFlightRef.current) return;
    jpegDecodeInFlightRef.current = true;

    try {
      while (true) {
        const data = jpegPendingFrameRef.current;
        jpegPendingFrameRef.current = null;
        if (!data) break;

        const blob = new Blob([data], { type: 'image/jpeg' });
        let bitmap: ImageBitmap;
        try {
          bitmap = await createImageBitmap(blob);
        } catch (err) {
          console.warn('JPEG frame decode failed, skipping corrupted frame:', err);
          continue;
        }

        const canvas = canvasRef.current;
        if (!canvas) {
          bitmap.close();
          continue;
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          bitmap.close();
          continue;
        }

        remoteScreenRef.current.width = bitmap.width;
        remoteScreenRef.current.height = bitmap.height;

        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }

        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        frameCountRef.current++;
      }
    } finally {
      jpegDecodeInFlightRef.current = false;

      // If a frame arrived right as we finished, kick the loop again.
      if (jpegPendingFrameRef.current) {
        Promise.resolve().then(() => { void processJpegFrames(); });
      }
    }
  }, []);

  const renderFrame = useCallback((data: ArrayBuffer) => {
    // Overwrite any pending frame; we only care about the latest.
    jpegPendingFrameRef.current = data;
    if (!jpegDecodeInFlightRef.current) {
      void processJpegFrames();
    }
  }, [processJpegFrames]);
  // Keep the ref in sync so connectWebSocket (defined earlier) always calls the latest version.
  renderFrameRef.current = renderFrame;

  // Map browser pixel coordinates to remote screen coordinates.
  const scaleCoordsFn = useCallback((clientX: number, clientY: number) => {
    if (transport === 'webrtc') {
      const videoEl = videoRef.current;
      if (!videoEl) return { x: 0, y: 0 };
      return scaleVideoCoords(clientX, clientY, videoEl);
    }

    // WebSocket canvas path
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      x: Math.round((clientX - rect.left) * scaleX / scale),
      y: Math.round((clientY - rect.top) * scaleY / scale),
    };
  }, [scale, transport]);

  // ── Input: send event ──────────────────────────────────────────────

  const sendInputFn = useCallback((event: Record<string, unknown>) => {
    const t = transportRef.current;
    if (t === 'webrtc') {
      const ch = webrtcRef.current?.inputChannel;
      if (ch && ch.readyState === 'open') {
        ch.send(JSON.stringify(event));
      }
      return;
    }

    const wsSession = wsRef.current;
    if (wsSession) {
      wsSession.inputChannel.send(JSON.stringify(event));
    }
  }, []);

  const releaseAllKeys = useCallback(() => {
    const keys = Array.from(pressedKeysRef.current);
    if (keys.length === 0) return;
    for (const key of keys) {
      sendInputFn({ type: 'key_up', key });
    }
    pressedKeysRef.current.clear();
  }, [sendInputFn]);
  releaseAllKeysRef.current = releaseAllKeys;

  const flushWebRTCMouseMove = useCallback(() => {
    webrtcMouseMoveRafRef.current = null;
    const pending = webrtcMouseMovePendingRef.current;
    if (!pending) return;

    const session = webrtcRef.current;
    if (!session) return;
    const ch = session.inputChannel;
    if (!ch || ch.readyState !== 'open') return;

    const maxBuffered = 512 * 1024;
    if (ch.bufferedAmount > maxBuffered) return; // wait for bufferedamountlow

    webrtcMouseMovePendingRef.current = null;
    ch.send(JSON.stringify({ type: 'mouse_move', x: pending.x, y: pending.y }));
  }, []);

  // Native wheel handler to enable preventDefault on non-passive listener
  useEffect(() => {
    if (!transport) return;
    const el = transport === 'webrtc' ? videoRef.current : canvasRef.current;
    if (!el) return;

    function onWheel(event: Event) {
      const e = event as WheelEvent;
      e.preventDefault();
      const r = wheelDeltaToSteps(wheelAccRef.current, e.deltaY, e.deltaMode);
      wheelAccRef.current = r.acc;
      if (r.steps === 0) return;
      const { x, y } = scaleCoordsFn(e.clientX, e.clientY);
      sendInputFn({ type: 'mouse_scroll', x, y, delta: r.steps });
    }

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [transport, scaleCoordsFn, sendInputFn]);

  // ── Input: mouse handlers ──────────────────────────────────────────

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const { x, y } = scaleCoordsFn(e.clientX, e.clientY);
    if (transport === 'webrtc') {
      webrtcMouseMovePendingRef.current = { x, y };
      if (webrtcMouseMoveRafRef.current === null) {
        webrtcMouseMoveRafRef.current = requestAnimationFrame(flushWebRTCMouseMove);
      }
      return;
    }
    sendInputFn({ type: 'mouse_move', x, y });
  }, [flushWebRTCMouseMove, scaleCoordsFn, sendInputFn, transport]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    // preventDefault on mousedown suppresses the browser's default focus behavior,
    // so explicitly re-focus the video/canvas to ensure keyboard events are captured.
    (e.currentTarget as HTMLElement).focus();
    // Flush any pending RAF mouse_move so the cursor is at the correct
    // position when the button press fires (consistent with mouseup).
    if (webrtcMouseMoveRafRef.current !== null) {
      cancelAnimationFrame(webrtcMouseMoveRafRef.current);
      webrtcMouseMoveRafRef.current = null;
    }
    const pending = webrtcMouseMovePendingRef.current;
    if (pending) {
      webrtcMouseMovePendingRef.current = null;
      sendInputFn({ type: 'mouse_move', x: pending.x, y: pending.y });
    }
    const { x, y } = scaleCoordsFn(e.clientX, e.clientY);
    const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    sendInputFn({ type: 'mouse_down', x, y, button });
  }, [scaleCoordsFn, sendInputFn]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    // Flush any pending RAF mouse_move so the final drag position arrives
    // before mouse_up — ensures the selection endpoint is correct.
    if (webrtcMouseMoveRafRef.current !== null) {
      cancelAnimationFrame(webrtcMouseMoveRafRef.current);
      webrtcMouseMoveRafRef.current = null;
    }
    const pending = webrtcMouseMovePendingRef.current;
    if (pending) {
      webrtcMouseMovePendingRef.current = null;
      sendInputFn({ type: 'mouse_move', x: pending.x, y: pending.y });
    }
    const { x, y } = scaleCoordsFn(e.clientX, e.clientY);
    const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    sendInputFn({ type: 'mouse_up', x, y, button });
  }, [scaleCoordsFn, sendInputFn]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // ── Input: paste as keystrokes ────────────────────────────────────

  const handlePasteAsKeystrokes = useCallback(async () => {
    let text: string;
    try {
      // Use Tauri native clipboard to bypass macOS "Allow Paste" prompt
      const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
      text = await readText();
    } catch (tauriErr) {
      console.warn('Tauri clipboard read failed, trying browser API:', tauriErr);
      try {
        text = await navigator.clipboard.readText();
      } catch (browserErr) {
        console.warn('Browser clipboard read also failed:', browserErr);
        return;
      }
    }
    if (!text) return;

    const events = textToKeyEvents(text);
    pasteCancelRef.current = false;
    setPasteProgress({ current: 0, total: events.length });

    for (let i = 0; i < events.length; i++) {
      if (pasteCancelRef.current) break;
      sendInputFn({ ...events[i] });

      if (i % 20 === 0) {
        setPasteProgress({ current: i + 1, total: events.length });
        // Yield to event loop every 20 chars to keep UI responsive
        await new Promise(r => setTimeout(r, 5));
      }
    }

    setPasteProgress(null);
  }, [sendInputFn]);

  const handleCancelPaste = useCallback(() => {
    pasteCancelRef.current = true;
  }, []);

  // ── Input: keyboard handlers ───────────────────────────────────────

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();

    // Modifier keys pressed alone: forward as key_down so Shift+Click,
    // Ctrl+Click, etc. hold the modifier on the remote machine for
    // multi-select. Skip the rest of the handler (no modifiers bundle,
    // no paste shortcut — those are handled when a non-modifier follows).
    if (isModifierOnly(e.nativeEvent)) {
      let modKey = mapKey(e.nativeEvent);
      if (!modKey) return;
      if (remapCmdCtrl) {
        if (modKey === 'ctrl') modKey = 'meta';
        else if (modKey === 'meta') modKey = 'ctrl';
      }
      if (e.repeat) return;
      if (pressedKeysRef.current.has(modKey)) return;
      pressedKeysRef.current.add(modKey);
      sendInputFn({ type: 'key_down', key: modKey });
      return;
    }

    // Ctrl+Shift+V / Cmd+Shift+V → paste as keystrokes
    const ne = e.nativeEvent;
    if (ne.code === 'KeyV' && ne.shiftKey && (ne.ctrlKey || ne.metaKey)) {
      handlePasteAsKeystrokes();
      return;
    }

    // Ctrl+V / Cmd+V → push local clipboard to remote before pasting.
    // Must await the clipboard sync BEFORE dispatching the key_press, or the
    // keystroke lands on the agent ahead of the clipboard payload and pastes
    // the previous contents.
    if (ne.code === 'KeyV' && !ne.shiftKey && (ne.ctrlKey || ne.metaKey)) {
      const dc = clipboardDCRef.current;
      const pasteKey = mapKey(ne);
      let pasteModifiers = getModifiers(ne);
      if (remapCmdCtrl && pasteModifiers.length > 0) {
        pasteModifiers = pasteModifiers.map(m =>
          m === 'ctrl' ? 'meta' : m === 'meta' ? 'ctrl' : m
        );
      }
      const dispatchPaste = () => {
        if (pasteKey) sendInputFn({ type: 'key_press', key: pasteKey, modifiers: pasteModifiers });
      };
      const waitForAck = (hash: string, timeoutMs: number): Promise<void> => {
        if (!hash) return Promise.resolve();
        return new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            clipboardAckMapRef.current.delete(hash);
            resolve();
          }, timeoutMs);
          clipboardAckMapRef.current.set(hash, { resolve, timer });
        });
      };
      handleCtrlVPaste({
        dc,
        readText: async () => {
          const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
          return readText();
        },
        lastHash: lastClipboardHashRef,
        dispatchPaste,
        waitForAck,
      });
      return;
    }

    const key = mapKey(ne);
    if (!key) return;

    let modifiers = getModifiers(ne);
    // Swap ctrl↔meta so Mac Cmd+C → Ctrl+C on Windows and vice versa
    if (remapCmdCtrl && modifiers.length > 0) {
      modifiers = modifiers.map(m =>
        m === 'ctrl' ? 'meta' : m === 'meta' ? 'ctrl' : m
      );
    }

    // If any modifier is held, fall back to the agent's key_press (which applies modifiers).
    // Otherwise, use key_down/key_up for proper "held key" semantics.
    if (modifiers.length > 0) {
      sendInputFn({ type: 'key_press', key, modifiers });
      return;
    }

    if (e.repeat) return;
    if (pressedKeysRef.current.has(key)) return;
    pressedKeysRef.current.add(key);
    sendInputFn({ type: 'key_down', key });
  }, [sendInputFn, handlePasteAsKeystrokes, remapCmdCtrl]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();

    let key = mapKey(e.nativeEvent);
    if (!key) return;

    // Apply the same ctrl↔meta remap used on key_down so the agent sees
    // the matching release for the key that was pressed.
    if (isModifierOnly(e.nativeEvent) && remapCmdCtrl) {
      if (key === 'ctrl') key = 'meta';
      else if (key === 'meta') key = 'ctrl';
    }

    if (!pressedKeysRef.current.has(key)) return;
    pressedKeysRef.current.delete(key);
    sendInputFn({ type: 'key_up', key });
  }, [sendInputFn, remapCmdCtrl]);

  // ── Toolbar: config changes ────────────────────────────────────────

  const handleConfigChange = useCallback((newQuality: number, newScale: number, newMaxFps: number) => {
    setQuality(newQuality);
    setScale(newScale);
    setMaxFps(newMaxFps);

    if (transport === 'websocket') {
      wsRef.current?.sendRaw(JSON.stringify({
        type: 'config',
        quality: newQuality,
        scaleFactor: newScale,
        maxFps: newMaxFps,
      }));
    } else if (transport === 'webrtc') {
      const ch = webrtcRef.current?.controlChannel;
      if (ch && ch.readyState === 'open') {
        ch.send(JSON.stringify({ type: 'set_fps', value: newMaxFps }));
      }
    }
  }, [transport]);

  const handleBitrateChange = useCallback((newBitrate: number) => {
    setBitrate(newBitrate);
    const ch = webrtcRef.current?.controlChannel;
    if (ch && ch.readyState === 'open') {
      ch.send(JSON.stringify({ type: 'set_bitrate', value: newBitrate * 1000 }));
    }
  }, []);

  const handleSwitchMonitor = useCallback((index: number) => {
    const ch = webrtcRef.current?.controlChannel;
    if (ch && ch.readyState === 'open') {
      ch.send(JSON.stringify({ type: 'switch_monitor', value: index }));
    }
  }, []);

  const handleSwitchSession = useCallback(async (sessionId: number) => {
    if (switchingSessionRef.current) return;
    const auth = authRef.current;
    if (!auth) return;
    const target = sessions.find(s => s.sessionId === sessionId);
    const label = target?.username || `Session ${sessionId}`;

    switchingSessionRef.current = true;
    setSwitchingSession(label);
    stopReconnect();

    // Tear down current WebRTC session
    releaseAllKeys();

    if (webrtcMouseMoveRafRef.current !== null) {
      cancelAnimationFrame(webrtcMouseMoveRafRef.current);
      webrtcMouseMoveRafRef.current = null;
    }
    webrtcMouseMovePendingRef.current = null;

    const prevSession = webrtcRef.current;
    webrtcRef.current = null;
    const audioEl = audioElRef.current;
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
      audioElRef.current = null;
    }
    prevSession?.close();

    // Reset display state
    setMonitors([]);
    setActiveMonitor(0);
    setTransportState(null);

    try {
      const ok = await connectWebRTC(auth, sessionId);
      if (!ok) throw new Error('WebRTC connection failed');
      setActiveSessionId(sessionId);
    } catch (err) {
      // Try to reconnect to the previous session so the viewer isn't dead
      const prevId = activeSessionId ?? undefined;
      try {
        const recovered = await connectWebRTC(auth, prevId);
        if (recovered) {
          setErrorMessage(`Failed to switch to ${label}. Restored previous session.`);
        } else {
          setErrorMessage(`Failed to switch to ${label} and could not restore previous session`);
          startReconnectRef.current();
        }
      } catch {
        setErrorMessage(`Failed to switch to ${label} and could not restore previous session`);
        startReconnectRef.current();
      }
    } finally {
      switchingSessionRef.current = false;
      setSwitchingSession(null);
    }
  }, [sessions, activeSessionId, connectWebRTC, releaseAllKeys, setTransportState, stopReconnect]);

  const handleToggleAudio = useCallback(() => {
    const newEnabled = !audioEnabled;
    setAudioEnabled(newEnabled);
    // Mute/unmute the audio element
    const audioEl = audioElRef.current;
    if (audioEl) {
      audioEl.muted = !newEnabled;
      if (newEnabled) audioEl.play().catch((err) => {
        console.warn('Failed to play remote audio:', err.message);
        setAudioEnabled(false); // reset UI to reflect actual state
      });
    }
    // Tell the agent to start/stop sending audio frames
    const ch = webrtcRef.current?.controlChannel;
    if (ch && ch.readyState === 'open') {
      ch.send(JSON.stringify({ type: 'toggle_audio', value: newEnabled ? 1 : 0 }));
    }
  }, [audioEnabled]);

  const handleSendKeys = useCallback((key: string, modifiers: string[]) => {
    sendInputFn({ type: 'key_press', key, modifiers });
  }, [sendInputFn]);

  const handleSendSAS = useCallback(() => {
    const ch = webrtcRef.current?.controlChannel;
    if (ch && ch.readyState === 'open') {
      ch.send(JSON.stringify({ type: 'send_sas' }));
    } else {
      console.warn('Ctrl+Alt+Del (SAS) requires WebRTC transport');
    }
  }, []);

  const handleLockWorkstation = useCallback(() => {
    const ch = webrtcRef.current?.controlChannel;
    if (ch && ch.readyState === 'open') {
      ch.send(JSON.stringify({ type: 'lock_workstation' }));
    } else {
      console.warn('Lock workstation requires WebRTC transport');
    }
  }, []);

  const handleDisconnect = useCallback(() => {
    userDisconnectRef.current = true;
    stopReconnect();
    reconnectInFlightRef.current = false;
	    if (sessionRegisteredRef.current) {
	      sessionRegisteredRef.current = false;
	      invoke('unregister_session').catch((err) => {
	        console.error('Failed to unregister desktop session on disconnect:', err);
	      });
	    }
    releaseAllKeys();

    if (webrtcMouseMoveRafRef.current !== null) {
      cancelAnimationFrame(webrtcMouseMoveRafRef.current);
      webrtcMouseMoveRafRef.current = null;
    }
    webrtcMouseMovePendingRef.current = null;

    wsCleanupRef.current?.();
    wsCleanupRef.current = null;
    // Clean up audio element to release MediaStream resources
    const audioEl = audioElRef.current;
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
      audioElRef.current = null;
    }
    const rtcSession = webrtcRef.current;
    webrtcRef.current = null;
    rtcSession?.close();
    // Close VNC session and tunnel
    const vncSession = vncSessionRef.current;
    vncSessionRef.current = null;
    vncSession?.close();
    if (activeVncTunnelIdRef.current) {
      const tunnelId = activeVncTunnelIdRef.current;
      activeVncTunnelIdRef.current = null;
      const auth = authRef.current;
      if (auth) {
        void closeTunnel(tunnelId, { apiUrl: auth.apiUrl, accessToken: auth.accessToken });
      }
    }
    onDisconnect();
  }, [onDisconnect, releaseAllKeys, stopReconnect]);

  // ── Render ─────────────────────────────────────────────────────────

  const interactionProps = {
    onMouseMove: handleMouseMove,
    onMouseDown: handleMouseDown,
    onMouseUp: handleMouseUp,
    onContextMenu: handleContextMenu,
    onKeyDown: handleKeyDown,
    onKeyUp: handleKeyUp,
  };

  return (
    <div className="flex flex-col h-screen bg-gray-900">
      <ViewerToolbar
        status={status}
        hostname={hostname}
        connectedAt={connectedAt}
        fps={fps}
        transport={transport}
        quality={quality}
        scale={scale}
        maxFps={maxFps}
        bitrate={bitrate}
        pasteProgress={pasteProgress}
        remapCmdCtrl={remapCmdCtrl}
        monitors={monitors}
        activeMonitor={activeMonitor}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSwitchSession={handleSwitchSession}
        audioEnabled={audioEnabled}
        hasAudioTrack={hasAudioTrack}
        showRemoteCursor={showRemoteCursor}
        remoteOs={remoteOs}
        onRemapCmdCtrlChange={setRemapCmdCtrl}
        onShowRemoteCursorChange={setShowRemoteCursor}
        onConfigChange={handleConfigChange}
        onBitrateChange={handleBitrateChange}
        onSwitchMonitor={handleSwitchMonitor}
        onToggleAudio={handleToggleAudio}
        onSendKeys={handleSendKeys}
        onSendSAS={handleSendSAS}
        onLockWorkstation={handleLockWorkstation}
        onPasteAsKeystrokes={handlePasteAsKeystrokes}
        onCancelPaste={handleCancelPaste}
        reconnectSecondsLeft={reconnectSecondsLeft}
        webRTCAvailable={webRTCAvailable}
        remoteUserName={remoteUserName}
        desktopState={desktopState}
        onSwitchTransport={switchTransport}
      />
      <div className="flex-1 overflow-hidden flex items-center justify-center bg-black relative">
        {/* WebRTC: <video> element (hardware H264 decode) */}
        <video
          ref={videoRef}
          tabIndex={0}
          autoPlay
          playsInline
          muted
          className={`max-w-full max-h-full object-contain outline-none ${transport !== 'webrtc' ? 'hidden' : ''}`}
          style={{ cursor: cursorStreamActive && showRemoteCursor ? 'none' : 'default' }}
          {...interactionProps}
        />

        {/* Session switching overlay */}
        {switchingSession && (
          <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-20">
            <div className="text-center">
              <div className="animate-spin w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full mx-auto mb-3" />
              <p className="text-white text-sm">Switching to {switchingSession}...</p>
            </div>
          </div>
        )}

        {/* Remote cursor overlay — streamed at 120Hz independent of video frame rate */}
        <div
          ref={cursorOverlayRef}
          className="absolute top-0 left-0 pointer-events-none z-50"
          style={{ display: 'none', willChange: 'transform' }}
        >
          <svg width="12" height="16" viewBox="0 0 16 22" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M0 0V19L5.5 14L9 22L12 20.5L8.5 13H15L0 0Z" fill="white" stroke="black" strokeWidth="1.5"/>
          </svg>
        </div>

        {/* WebSocket: <canvas> element (JPEG software decode) */}
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className={`max-w-full max-h-full object-contain outline-none cursor-default ${transport !== 'websocket' ? 'hidden' : ''}`}
          {...interactionProps}
        />

        {/* VNC: noVNC container (shown only when transport is VNC) */}
        <div
          ref={vncContainerRef}
          className={`flex-1 min-h-0 w-full h-full bg-black overflow-hidden relative flex items-center justify-center ${transport !== 'vnc' ? 'hidden' : ''}`}
        />

        {/* VNC credentials prompt */}
        {credentialsPrompt && (
          <CredentialsPromptModal
            requiresUsername={credentialsPrompt.requiresUsername}
            onSubmit={(creds) => {
              credentialsPrompt.submit(creds);
              setCredentialsPrompt(null);
            }}
            onCancel={() => {
              setCredentialsPrompt(null);
              handleDisconnect();
            }}
          />
        )}

        {/* Transport-switching overlay */}
        {switchingTo && (
          <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-20">
            <div className="text-center">
              <div className="animate-spin w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full mx-auto mb-3" />
              <p className="text-white text-sm">Switching to {switchingTo}...</p>
            </div>
          </div>
        )}

        {status === 'connecting' && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80">
            <div className="text-center">
              <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-4" />
              <p className="text-gray-300">Connecting to remote desktop...</p>
            </div>
          </div>
        )}
        {status === 'reconnecting' && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/60 backdrop-blur-[2px]">
            <div className="text-center bg-gray-900/80 rounded-xl px-8 py-6 shadow-2xl border border-orange-700/50">
              <div className="animate-spin w-8 h-8 border-2 border-orange-500 border-t-transparent rounded-full mx-auto mb-4" />
              <p className="text-gray-200 font-medium mb-1">Reconnecting...</p>
              <p className="text-gray-400 text-sm mb-4">
                {reconnectSecondsLeft > 0
                  ? `Retrying connection (${reconnectSecondsLeft}s remaining)`
                  : 'Attempting to reconnect...'}
              </p>
              <button
                onClick={handleDisconnect}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80">
            <div className="text-center">
              <p className="text-red-400 mb-2">Connection Error</p>
              {errorMessage && <p className="text-gray-400 text-sm mb-4">{errorMessage}</p>}
              <button
                onClick={onDisconnect}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white"
              >
                Close
              </button>
            </div>
          </div>
        )}
        {status === 'disconnected' && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/50 backdrop-blur-sm">
            <div className="text-center bg-gray-900/70 rounded-xl px-8 py-6 shadow-2xl border border-gray-700/50">
              <p className="text-gray-200 font-medium mb-1">Session Ended</p>
              <p className="text-gray-400 text-sm mb-4">The remote desktop connection was closed</p>
              <button
                onClick={onDisconnect}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white text-sm"
              >
                Close Viewer
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
