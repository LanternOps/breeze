import { useEffect, useRef, useCallback, useState } from 'react';
import { buildWsUrl, type ConnectionParams } from '../lib/protocol';
import { createDesktopWsTicket, exchangeDesktopConnectCode } from '../lib/api';
import { createWebRTCSession, scaleVideoCoords, type AuthenticatedConnectionParams, type WebRTCSession } from '../lib/webrtc';
import { mapKey, getModifiers, isModifierOnly } from '../lib/keymap';
import { textToKeyEvents } from '../lib/paste';
import { DEFAULT_WHEEL_ACCUMULATOR, wheelDeltaToSteps } from '../lib/wheel';
import ViewerToolbar from './ViewerToolbar';

interface Props {
  params: ConnectionParams;
  onDisconnect: () => void;
  onError: (msg: string) => void;
}

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
type Transport = 'webrtc' | 'websocket';

export default function DesktopViewer({ params, onDisconnect, onError }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const webrtcRef = useRef<WebRTCSession | null>(null);
  const transportRef = useRef<Transport | null>(null);
  const wsCleanupRef = useRef<(() => void) | null>(null);
  const authRef = useRef<AuthenticatedConnectionParams | null>(null);
  const cancelledRef = useRef(false);
  const webrtcFallbackAttemptedRef = useRef(false);
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const wheelAccRef = useRef(DEFAULT_WHEEL_ACCUMULATOR);
  const pasteCancelRef = useRef(false);

  const webrtcMouseMovePendingRef = useRef<{ x: number; y: number } | null>(null);
  const webrtcMouseMoveRafRef = useRef<number | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [transport, setTransport] = useState<Transport | null>(null);
  const [fps, setFps] = useState(0);
  const [quality, setQuality] = useState(60);
  const [scale, setScale] = useState(1.0);
  const [maxFps, setMaxFps] = useState(15);
  const [bitrate, setBitrate] = useState(2500);
  const [hostname, setHostname] = useState('');
  const [connectedAt, setConnectedAt] = useState<Date | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pasteProgress, setPasteProgress] = useState<{ current: number; total: number } | null>(null);

  const setTransportState = useCallback((t: Transport | null) => {
    transportRef.current = t;
    setTransport(t);
  }, []);

  // Frame rate tracking
  const frameCountRef = useRef(0);
  const fpsIntervalRef = useRef<ReturnType<typeof setInterval>>();

  // Remote screen size (actual pixels from agent)
  const remoteScreenRef = useRef({ width: 1920, height: 1080 });

  // WebSocket JPEG decode backpressure: keep at most one decode in-flight and
  // always prefer the latest pending frame.
  const jpegDecodeInFlightRef = useRef(false);
  const jpegPendingFrameRef = useRef<ArrayBuffer | null>(null);

  // ── WebRTC connection ──────────────────────────────────────────────

  const connectWebRTC = useCallback(async (auth: AuthenticatedConnectionParams): Promise<boolean> => {
    const videoEl = videoRef.current;
    if (!videoEl) return false;

	    try {
	      const session = await createWebRTCSession(auth, videoEl);
	      webrtcRef.current = session;

	      // Reduce input lag under loss: coalesce mouse moves, and avoid unbounded buffering.
	      try {
	        session.inputChannel.bufferedAmountLowThreshold = 256 * 1024;
	        session.inputChannel.onbufferedamountlow = () => {
	          if (webrtcMouseMovePendingRef.current && webrtcMouseMoveRafRef.current === null) {
	            webrtcMouseMoveRafRef.current = requestAnimationFrame(flushWebRTCMouseMove);
	          }
	        };
	      } catch {
	        // Some environments may not support these fields.
	      }

	      // Monitor connection state
	      session.pc.onconnectionstatechange = () => {
	        if (webrtcRef.current !== session) return;
	        const state = session.pc.connectionState;
	        if (state === 'connected') {
	          setStatus('connected');
	          setConnectedAt(new Date());
	          setErrorMessage(null);
	          // Ensure keyboard input is captured without an extra click.
	          videoRef.current?.focus();
	        } else if (state === 'failed') {
	          void fallbackToWebSocket('WebRTC connection failed. Falling back to WebSocket...');
	        } else if (state === 'closed') {
	          setStatus('disconnected');
	          setConnectedAt(null);
	        }
	      };

      setTransportState('webrtc');
      setHostname('Remote Desktop');
      // Connection state will flip to 'connected' via onconnectionstatechange
      return true;
    } catch (err) {
      console.warn('WebRTC connection failed:', err);
      return false;
    }
  }, []);

  // ── WebSocket connection (fallback) ────────────────────────────────

  const connectWebSocket = useCallback(async (auth: AuthenticatedConnectionParams) => {
    const wsTicket = await createDesktopWsTicket(auth.apiUrl, auth.accessToken, auth.sessionId);
    if (!wsTicket) {
      setStatus('error');
      setErrorMessage('Failed to create connection ticket');
      onError('Failed to create connection ticket');
      return null;
    }

    const wsUrl = buildWsUrl(auth.apiUrl, auth.sessionId, wsTicket);
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    let closed = false;
    let hadError = false;

    // Ping keep-alive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 15000);

	    const cleanup = () => {
	      // Always clear the shared cleanup ref, even if already closed (race-safe).
	      wsCleanupRef.current = null;
	      if (closed) return;
	      closed = true;
	      clearInterval(pingInterval);
	      wsRef.current = null;
	      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
	        ws.close();
	      }
	    };

	    // Expose cleanup immediately so early onerror/onclose can clear it.
	    wsCleanupRef.current = cleanup;

    ws.onopen = () => {
      console.log('Desktop WebSocket connected');
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        renderFrame(event.data);
        return;
      }

      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'connected':
            setStatus('connected');
            setHostname(msg.device?.hostname || 'Unknown');
            setConnectedAt(new Date());
            setErrorMessage(null);
            // Auto-focus the canvas so keyboard events are captured immediately
            canvasRef.current?.focus();
            break;
          case 'pong':
            break;
          case 'error':
            console.error('Server error:', msg.message);
            setStatus('error');
            setConnectedAt(null);
            setErrorMessage(msg.message || 'Remote desktop error');
            hadError = true;
            cleanup();
            onError(msg.message || 'Remote desktop error');
            break;
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onclose = () => {
      cleanup();
      setConnectedAt(null);
      if (!hadError) setStatus('disconnected');
    };

    ws.onerror = () => {
      hadError = true;
      setStatus('error');
      setErrorMessage('WebSocket connection error');
      setConnectedAt(null);
      cleanup();
      onError('WebSocket connection error');
    };

    setTransportState('websocket');

    return cleanup;
  }, [onError]);

  async function fallbackToWebSocket(reason: string) {
    if (cancelledRef.current) return;
    if (webrtcFallbackAttemptedRef.current) return;

    const auth = authRef.current;
    if (!auth) return;

    webrtcFallbackAttemptedRef.current = true;

    console.warn(reason);
    setStatus('connecting');
    setTransportState(null);
    setConnectedAt(null);
    setErrorMessage(null);

    if (webrtcMouseMoveRafRef.current !== null) {
      cancelAnimationFrame(webrtcMouseMoveRafRef.current);
      webrtcMouseMoveRafRef.current = null;
    }
    webrtcMouseMovePendingRef.current = null;

    // Best-effort: release any held keys before switching transports.
    releaseAllKeys();

    // Tear down the WebRTC session before starting WS fallback.
    webrtcRef.current?.close();
    webrtcRef.current = null;

    const cleanup = await connectWebSocket(auth);
    if (cancelledRef.current) {
      cleanup?.();
      return;
    }
    if (cleanup) {
      wsCleanupRef.current = cleanup;
    }
  }

  // ── Connection lifecycle ───────────────────────────────────────────

  useEffect(() => {
    cancelledRef.current = false;
    webrtcFallbackAttemptedRef.current = false;
    authRef.current = null;
    wheelAccRef.current = DEFAULT_WHEEL_ACCUMULATOR;

    // Ensure any previous transport is fully torn down before reconnect.
    releaseAllKeys();
    wsCleanupRef.current?.();
    wsCleanupRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    webrtcRef.current?.close();
    webrtcRef.current = null;

    setStatus('connecting');
    setTransportState(null);
    setHostname('');
    setConnectedAt(null);
    setErrorMessage(null);

    async function connect() {
      try {
        const exchange = await exchangeDesktopConnectCode(
          params.apiUrl,
          params.sessionId,
          params.connectCode
        );
        if (cancelledRef.current) return;

        if (!exchange?.accessToken) {
          setStatus('error');
          setErrorMessage('Invalid or expired connection code');
          setConnectedAt(null);
          onError('Invalid or expired connection code');
          return;
        }

        const authParams: AuthenticatedConnectionParams = {
          sessionId: params.sessionId,
          apiUrl: params.apiUrl,
          accessToken: exchange.accessToken
        };
        authRef.current = authParams;

        // Try WebRTC first
        const webrtcOk = await connectWebRTC(authParams);
        if (cancelledRef.current) {
          webrtcRef.current?.close();
          webrtcRef.current = null;
          return;
        }

        if (!webrtcOk) {
          // Fall back to WebSocket
          const cleanup = await connectWebSocket(authParams);
          if (cancelledRef.current) {
            cleanup?.();
            return;
          }
          wsCleanupRef.current = cleanup;
        }
      } catch (err) {
        if (cancelledRef.current) return;
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
      cancelledRef.current = true;

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
      webrtcRef.current?.close();
      webrtcRef.current = null;
    };
  }, [connectWebRTC, connectWebSocket, onError, params]);

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
        } catch {
          // Skip corrupted frames
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

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', event }));
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
    const { x, y } = scaleCoordsFn(e.clientX, e.clientY);
    const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    sendInputFn({ type: 'mouse_down', x, y, button });
  }, [scaleCoordsFn, sendInputFn]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
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
      text = await navigator.clipboard.readText();
    } catch {
      return;
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
    if (isModifierOnly(e.nativeEvent)) return;

    // Ctrl+Shift+V / Cmd+Shift+V → paste as keystrokes
    const ne = e.nativeEvent;
    if (ne.code === 'KeyV' && ne.shiftKey && (ne.ctrlKey || ne.metaKey)) {
      handlePasteAsKeystrokes();
      return;
    }

    const key = mapKey(ne);
    if (!key) return;

    const modifiers = getModifiers(ne);
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
  }, [sendInputFn, handlePasteAsKeystrokes]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
    if (isModifierOnly(e.nativeEvent)) return;

    const key = mapKey(e.nativeEvent);
    if (!key) return;

    if (!pressedKeysRef.current.has(key)) return;
    pressedKeysRef.current.delete(key);
    sendInputFn({ type: 'key_up', key });
  }, [sendInputFn]);

  // ── Toolbar: config changes ────────────────────────────────────────

  const handleConfigChange = useCallback((newQuality: number, newScale: number, newMaxFps: number) => {
    setQuality(newQuality);
    setScale(newScale);
    setMaxFps(newMaxFps);

    if (transport === 'websocket') {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'config',
          quality: newQuality,
          scaleFactor: newScale,
          maxFps: newMaxFps,
        }));
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

  const handleSendKeys = useCallback((key: string, modifiers: string[]) => {
    sendInputFn({ type: 'key_press', key, modifiers });
  }, [sendInputFn]);

  const handleDisconnect = useCallback(() => {
    releaseAllKeys();

    if (webrtcMouseMoveRafRef.current !== null) {
      cancelAnimationFrame(webrtcMouseMoveRafRef.current);
      webrtcMouseMoveRafRef.current = null;
    }
    webrtcMouseMovePendingRef.current = null;

    wsCleanupRef.current?.();
    wsCleanupRef.current = null;
    webrtcRef.current?.close();
    webrtcRef.current = null;
    onDisconnect();
  }, [onDisconnect, releaseAllKeys]);

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
        onConfigChange={handleConfigChange}
        onBitrateChange={handleBitrateChange}
        onSendKeys={handleSendKeys}
        onPasteAsKeystrokes={handlePasteAsKeystrokes}
        onCancelPaste={handleCancelPaste}
        onDisconnect={handleDisconnect}
      />
      <div className="flex-1 overflow-hidden flex items-center justify-center bg-black">
        {/* WebRTC: <video> element (hardware H264 decode) */}
        <video
          ref={videoRef}
          tabIndex={0}
          autoPlay
          playsInline
          muted
          className={`max-w-full max-h-full object-contain outline-none cursor-default ${transport !== 'webrtc' ? 'hidden' : ''}`}
          {...interactionProps}
        />

        {/* WebSocket: <canvas> element (JPEG software decode) */}
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className={`max-w-full max-h-full object-contain outline-none cursor-default ${transport !== 'websocket' ? 'hidden' : ''}`}
          {...interactionProps}
        />

        {status === 'connecting' && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80">
            <div className="text-center">
              <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-4" />
              <p className="text-gray-300">Connecting to remote desktop...</p>
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
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80">
            <div className="text-center">
              <p className="text-gray-300 mb-4">Connection closed</p>
              <button
                onClick={onDisconnect}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
