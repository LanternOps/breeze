import { useState, useEffect } from 'react';
import type { ComponentType } from 'react';
import { Monitor, Wifi, WifiOff, Maximize, Minimize, Power, Keyboard } from 'lucide-react';

interface Props {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  hostname: string;
  connectedAt: Date | null;
  fps: number;
  transport: 'webrtc' | 'websocket' | null;
  quality: number;
  scale: number;
  maxFps: number;
  bitrate: number;
  onConfigChange: (quality: number, scale: number, maxFps: number) => void;
  onBitrateChange: (bitrate: number) => void;
  onCtrlAltDel: () => void;
  onDisconnect: () => void;
}

function formatDuration(startDate: Date): string {
  const seconds = Math.floor((Date.now() - startDate.getTime()) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function ViewerToolbar({
  status,
  hostname,
  connectedAt,
  fps,
  transport,
  quality,
  scale,
  maxFps,
  bitrate,
  onConfigChange,
  onBitrateChange,
  onCtrlAltDel,
  onDisconnect,
}: Props) {
  const MonitorIcon = Monitor as unknown as ComponentType<{ className?: string }>;
  const ConnectedIcon = Wifi as unknown as ComponentType<{ className?: string }>;
  const DisconnectedIcon = WifiOff as unknown as ComponentType<{ className?: string }>;
  const MinimizeIcon = Minimize as unknown as ComponentType<{ className?: string }>;
  const MaximizeIcon = Maximize as unknown as ComponentType<{ className?: string }>;
  const PowerIcon = Power as unknown as ComponentType<{ className?: string }>;
  const KeyboardIcon = Keyboard as unknown as ComponentType<{ className?: string }>;

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [duration, setDuration] = useState('0:00');

  // Update duration every second
  useEffect(() => {
    if (!connectedAt) return;
    const interval = setInterval(() => {
      setDuration(formatDuration(connectedAt));
    }, 1000);
    return () => clearInterval(interval);
  }, [connectedAt]);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch {
      // Fullscreen not supported or denied
    }
  };

  const statusColor = {
    connecting: 'text-yellow-400',
    connected: 'text-green-400',
    disconnected: 'text-gray-400',
    error: 'text-red-400',
  }[status];

  const StatusIcon = status === 'connected' ? ConnectedIcon : DisconnectedIcon;

  const isWebRTC = transport === 'webrtc';

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 bg-gray-800 border-b border-gray-700 text-sm select-none">
      {/* Connection info */}
      <div className="flex items-center gap-2">
        <MonitorIcon className="w-4 h-4 text-gray-400" />
        <span className="text-gray-200 font-medium">{hostname || 'Connecting...'}</span>
        <StatusIcon className={`w-3.5 h-3.5 ${statusColor}`} />
        {connectedAt && (
          <span className="text-gray-500 text-xs">{duration}</span>
        )}
      </div>

      <div className="w-px h-5 bg-gray-600" />

      {/* Transport indicator */}
      {transport && (
        <>
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
            isWebRTC
              ? 'bg-green-900/50 text-green-400 border border-green-800'
              : 'bg-blue-900/50 text-blue-400 border border-blue-800'
          }`}>
            {isWebRTC ? 'WebRTC' : 'WS'}
          </span>
          <div className="w-px h-5 bg-gray-600" />
        </>
      )}

      {/* FPS */}
      <span className="text-gray-400 text-xs tabular-nums">{fps} FPS</span>

      <div className="w-px h-5 bg-gray-600" />

      {/* WebRTC mode: Bitrate control */}
      {isWebRTC && (
        <div className="flex items-center gap-1.5">
          <label className="text-gray-400 text-xs">Bitrate</label>
          <input
            type="range"
            min="500"
            max="8000"
            step="250"
            value={bitrate}
            onChange={(e) => onBitrateChange(parseInt(e.target.value))}
            className="w-16 h-1 accent-green-500"
          />
          <span className="text-gray-400 text-xs w-12 tabular-nums">{bitrate >= 1000 ? `${(bitrate / 1000).toFixed(1)}M` : `${bitrate}K`}</span>
        </div>
      )}

      {/* WebSocket mode: Quality / Scale / FPS Limit */}
      {!isWebRTC && (
        <>
          <div className="flex items-center gap-1.5">
            <label className="text-gray-400 text-xs">Quality</label>
            <input
              type="range"
              min="10"
              max="100"
              step="5"
              value={quality}
              onChange={(e) => onConfigChange(parseInt(e.target.value), scale, maxFps)}
              className="w-16 h-1 accent-blue-500"
            />
            <span className="text-gray-400 text-xs w-6 tabular-nums">{quality}</span>
          </div>

          <div className="flex items-center gap-1.5">
            <label className="text-gray-400 text-xs">Scale</label>
            <select
              value={scale}
              onChange={(e) => onConfigChange(quality, parseFloat(e.target.value), maxFps)}
              className="bg-gray-700 text-gray-300 text-xs rounded px-1 py-0.5 border border-gray-600"
            >
              <option value={0.25}>25%</option>
              <option value={0.5}>50%</option>
              <option value={0.75}>75%</option>
              <option value={1.0}>100%</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <label className="text-gray-400 text-xs">FPS Limit</label>
            <select
              value={maxFps}
              onChange={(e) => onConfigChange(quality, scale, parseInt(e.target.value))}
              className="bg-gray-700 text-gray-300 text-xs rounded px-1 py-0.5 border border-gray-600"
            >
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={15}>15</option>
              <option value={20}>20</option>
              <option value={30}>30</option>
            </select>
          </div>
        </>
      )}

      <div className="flex-1" />

      {/* Actions */}
      <button
        onClick={onCtrlAltDel}
        className="flex items-center gap-1 px-2 py-1 text-xs text-gray-300 hover:text-white hover:bg-gray-700 rounded"
        title="Send Ctrl+Alt+Del"
      >
        <KeyboardIcon className="w-3.5 h-3.5" />
        <span>Ctrl+Alt+Del</span>
      </button>

      <button
        onClick={toggleFullscreen}
        className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded"
        title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
      >
        {isFullscreen ? <MinimizeIcon className="w-4 h-4" /> : <MaximizeIcon className="w-4 h-4" />}
      </button>

      <button
        onClick={onDisconnect}
        className="flex items-center gap-1 px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-gray-700 rounded"
        title="Disconnect"
      >
        <PowerIcon className="w-3.5 h-3.5" />
        <span>Disconnect</span>
      </button>
    </div>
  );
}
