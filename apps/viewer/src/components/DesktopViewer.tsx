import { useEffect, useRef, useCallback, useState } from 'react';
import { buildWsUrl, type ConnectionParams } from '../lib/protocol';
import { createWebRTCSession, scaleVideoCoords, type WebRTCSession } from '../lib/webrtc';
import { mapKey, getModifiers, isModifierOnly } from '../lib/keymap';
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
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [transport, setTransport] = useState<Transport | null>(null);
  const [fps, setFps] = useState(0);
  const [quality, setQuality] = useState(60);
  const [scale, setScale] = useState(0.5);
  const [maxFps, setMaxFps] = useState(15);
  const [bitrate, setBitrate] = useState(2500);
  const [hostname, setHostname] = useState('');
  const [connectedAt, setConnectedAt] = useState<Date | null>(null);

  // Frame rate tracking
  const frameCountRef = useRef(0);
  const fpsIntervalRef = useRef<ReturnType<typeof setInterval>>();

  // Remote screen size (actual pixels from agent)
  const remoteScreenRef = useRef({ width: 1920, height: 1080 });

  // ── WebRTC connection ──────────────────────────────────────────────

  const connectWebRTC = useCallback(async (): Promise<boolean> => {
    const videoEl = videoRef.current;
    if (!videoEl) return false;

    try {
      const session = await createWebRTCSession(params, videoEl);
      webrtcRef.current = session;

      // Monitor connection state
      session.pc.onconnectionstatechange = () => {
        const state = session.pc.connectionState;
        if (state === 'connected') {
          setStatus('connected');
          setConnectedAt(new Date());
        } else if (state === 'failed' || state === 'closed') {
          setStatus('disconnected');
        }
      };

      setTransport('webrtc');
      setHostname('Remote Desktop');
      // Connection state will flip to 'connected' via onconnectionstatechange
      return true;
    } catch (err) {
      console.warn('WebRTC connection failed:', err);
      return false;
    }
  }, [params]);

  // ── WebSocket connection (fallback) ────────────────────────────────

  const connectWebSocket = useCallback(() => {
    const wsUrl = buildWsUrl(params);
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('Desktop WebSocket connected');
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        renderFrame(new Uint8Array(event.data));
        return;
      }

      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'connected':
            setStatus('connected');
            setHostname(msg.device?.hostname || 'Unknown');
            setConnectedAt(new Date());
            break;
          case 'pong':
            break;
          case 'error':
            console.error('Server error:', msg.message);
            if (msg.code === 'AUTH_FAILED' || msg.code === 'AGENT_OFFLINE') {
              onError(msg.message);
            }
            break;
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onclose = () => {
      setStatus('disconnected');
    };

    ws.onerror = () => {
      setStatus('error');
      onError('WebSocket connection error');
    };

    // Ping keep-alive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 15000);

    setTransport('websocket');

    return () => {
      clearInterval(pingInterval);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      wsRef.current = null;
    };
  }, [params, onError]);

  // ── Connection lifecycle ───────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    let wsCleanup: (() => void) | null = null;

    async function connect() {
      // Try WebRTC first
      const webrtcOk = await connectWebRTC();
      if (cancelled) {
        webrtcRef.current?.close();
        return;
      }

      if (!webrtcOk) {
        // Fall back to WebSocket
        wsCleanup = connectWebSocket();
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
      clearInterval(fpsIntervalRef.current);
      wsCleanup?.();
      webrtcRef.current?.close();
      webrtcRef.current = null;
    };
  }, [connectWebRTC, connectWebSocket]);

  // Count WebRTC video frames via requestVideoFrameCallback
  useEffect(() => {
    if (transport !== 'webrtc') return;
    const videoEl = videoRef.current;
    if (!videoEl) return;

    let active = true;
    function countFrame() {
      if (!active) return;
      frameCountRef.current++;
      videoEl!.requestVideoFrameCallback(countFrame);
    }
    videoEl.requestVideoFrameCallback(countFrame);
    return () => { active = false; };
  }, [transport]);

  // ── Frame rendering (WebSocket JPEG path) ──────────────────────────

  const renderFrame = useCallback((data: Uint8Array) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const copy = new Uint8Array(data);
    const blob = new Blob([copy], { type: 'image/jpeg' });
    createImageBitmap(blob).then((bitmap) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      remoteScreenRef.current.width = bitmap.width;
      remoteScreenRef.current.height = bitmap.height;

      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }

      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      frameCountRef.current++;
    }).catch(() => {
      // Skip corrupted frames
    });
  }, []);

  // ── Input: coordinate scaling ──────────────────────────────────────

  const scaleCoords = useCallback((clientX: number, clientY: number) => {
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
      x: Math.round((clientX - rect.left) * scaleX),
      y: Math.round((clientY - rect.top) * scaleY),
    };
  }, [transport]);

  // ── Input: send event ──────────────────────────────────────────────

  const sendInput = useCallback((event: Record<string, unknown>) => {
    if (transport === 'webrtc') {
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
  }, [transport]);

  // ── Input: mouse handlers ──────────────────────────────────────────

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const { x, y } = scaleCoords(e.clientX, e.clientY);
    sendInput({ type: 'mouse_move', x, y });
  }, [scaleCoords, sendInput]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const { x, y } = scaleCoords(e.clientX, e.clientY);
    const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    sendInput({ type: 'mouse_down', x, y, button });
  }, [scaleCoords, sendInput]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const { x, y } = scaleCoords(e.clientX, e.clientY);
    const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    sendInput({ type: 'mouse_up', x, y, button });
  }, [scaleCoords, sendInput]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const { x, y } = scaleCoords(e.clientX, e.clientY);
    sendInput({ type: 'mouse_scroll', x, y, delta: Math.sign(e.deltaY) * 3 });
  }, [scaleCoords, sendInput]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // ── Input: keyboard handlers ───────────────────────────────────────

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
    if (isModifierOnly(e.nativeEvent)) return;

    const key = mapKey(e.nativeEvent);
    if (!key) return;

    const modifiers = getModifiers(e.nativeEvent);
    sendInput({ type: 'key_press', key, modifiers });
  }, [sendInput]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
  }, []);

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

  const handleCtrlAltDel = useCallback(() => {
    sendInput({ type: 'key_press', key: 'delete', modifiers: ['ctrl', 'alt'] });
  }, [sendInput]);

  const handleDisconnect = useCallback(() => {
    wsRef.current?.close();
    webrtcRef.current?.close();
    onDisconnect();
  }, [onDisconnect]);

  // ── Render ─────────────────────────────────────────────────────────

  const interactionProps = {
    onMouseMove: handleMouseMove,
    onMouseDown: handleMouseDown,
    onMouseUp: handleMouseUp,
    onWheel: handleWheel,
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
        onConfigChange={handleConfigChange}
        onBitrateChange={handleBitrateChange}
        onCtrlAltDel={handleCtrlAltDel}
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
          style={{ imageRendering: 'auto' }}
          {...interactionProps}
        />

        {/* WebSocket: <canvas> element (JPEG software decode) */}
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className={`max-w-full max-h-full object-contain outline-none cursor-default ${transport !== 'websocket' ? 'hidden' : ''}`}
          style={{ imageRendering: 'auto' }}
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
