import { useEffect, useRef, useCallback, useState } from 'react';
import { buildWsUrl, type ConnectionParams } from '../lib/protocol';
import { mapKey, getModifiers, isModifierOnly } from '../lib/keymap';
import ViewerToolbar from './ViewerToolbar';

interface Props {
  params: ConnectionParams;
  onDisconnect: () => void;
  onError: (msg: string) => void;
}

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export default function DesktopViewer({ params, onDisconnect, onError }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [fps, setFps] = useState(0);
  const [quality, setQuality] = useState(60);
  const [scale, setScale] = useState(1.0);
  const [maxFps, setMaxFps] = useState(15);
  const [hostname, setHostname] = useState('');
  const [connectedAt, setConnectedAt] = useState<Date | null>(null);

  // Frame rate tracking
  const frameCountRef = useRef(0);
  const fpsIntervalRef = useRef<ReturnType<typeof setInterval>>();

  // Remote screen size (actual pixels from agent)
  const remoteScreenRef = useRef({ width: 1920, height: 1080 });

  // Connect WebSocket
  useEffect(() => {
    const wsUrl = buildWsUrl(params);
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('Desktop WebSocket connected');
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        // Binary JPEG frame
        renderFrame(new Uint8Array(event.data));
        return;
      }

      // JSON message
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'connected':
            setStatus('connected');
            setHostname(msg.device?.hostname || 'Unknown');
            setConnectedAt(new Date());
            // Auto-focus the canvas so keyboard events are captured immediately
            canvasRef.current?.focus();
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

    // FPS counter
    fpsIntervalRef.current = setInterval(() => {
      setFps(frameCountRef.current);
      frameCountRef.current = 0;
    }, 1000);

    // Ping keep-alive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 15000);

    return () => {
      clearInterval(fpsIntervalRef.current);
      clearInterval(pingInterval);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      wsRef.current = null;
    };
  }, [params, onError]);

  // Render a JPEG frame on the canvas
  const renderFrame = useCallback((data: Uint8Array) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Copy into a plain ArrayBuffer to avoid SharedArrayBuffer type issues
    const copy = new Uint8Array(data);
    const blob = new Blob([copy], { type: 'image/jpeg' });
    createImageBitmap(blob).then((bitmap) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Update remote screen dimensions from actual frame size
      remoteScreenRef.current.width = bitmap.width;
      remoteScreenRef.current.height = bitmap.height;

      // Resize canvas to match frame
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

  // Map browser pixel coordinates to full remote screen coordinates.
  // The canvas dimensions match the scaled frame (e.g. 960x540 at 50%),
  // but the agent expects coordinates in the full screen space (1920x1080).
  const scaleCoords = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      x: Math.round((clientX - rect.left) * scaleX / scale),
      y: Math.round((clientY - rect.top) * scaleY / scale),
    };
  }, [scale]);

  // Send input event
  const sendInput = useCallback((event: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', event }));
    }
  }, []);

  // Mouse handlers
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

  // Keyboard handlers
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

  // Config change handler
  const handleConfigChange = useCallback((newQuality: number, newScale: number, newMaxFps: number) => {
    setQuality(newQuality);
    setScale(newScale);
    setMaxFps(newMaxFps);

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'config',
        quality: newQuality,
        scaleFactor: newScale,
        maxFps: newMaxFps,
      }));
    }
  }, []);

  // Ctrl+Alt+Del handler
  const handleCtrlAltDel = useCallback(() => {
    sendInput({ type: 'key_press', key: 'delete', modifiers: ['ctrl', 'alt'] });
  }, [sendInput]);

  // Disconnect handler
  const handleDisconnect = useCallback(() => {
    const ws = wsRef.current;
    if (ws) {
      ws.close();
    }
    onDisconnect();
  }, [onDisconnect]);

  return (
    <div className="flex flex-col h-screen bg-gray-900">
      <ViewerToolbar
        status={status}
        hostname={hostname}
        connectedAt={connectedAt}
        fps={fps}
        quality={quality}
        scale={scale}
        maxFps={maxFps}
        onConfigChange={handleConfigChange}
        onCtrlAltDel={handleCtrlAltDel}
        onDisconnect={handleDisconnect}
      />
      <div className="flex-1 overflow-hidden flex items-center justify-center bg-black">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className="max-w-full max-h-full object-contain outline-none cursor-default"
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          onContextMenu={handleContextMenu}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          style={{ imageRendering: 'auto' }}
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
