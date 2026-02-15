import { useState, useEffect, useRef } from 'react';
import type { ComponentType } from 'react';
import { Monitor, Wifi, WifiOff, Maximize, Minimize, Power, Keyboard, ClipboardPaste, ChevronDown, X, ArrowLeftRight, Volume2, VolumeX } from 'lucide-react';

interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  isPrimary: boolean;
}

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
  pasteProgress: { current: number; total: number } | null;
  remapCmdCtrl: boolean;
  monitors: MonitorInfo[];
  activeMonitor: number;
  audioEnabled: boolean;
  hasAudioTrack: boolean;
  onRemapCmdCtrlChange: (v: boolean) => void;
  onConfigChange: (quality: number, scale: number, maxFps: number) => void;
  onBitrateChange: (bitrate: number) => void;
  onSwitchMonitor: (index: number) => void;
  onToggleAudio: () => void;
  onSendKeys: (key: string, modifiers: string[]) => void;
  onPasteAsKeystrokes: () => void;
  onCancelPaste: () => void;
  onDisconnect: () => void;
}

interface KeyCombo {
  label: string;
  key: string;
  modifiers: string[];
  description: string;
}

const KEY_COMBOS: KeyCombo[] = [
  { label: 'Ctrl+Alt+Del',    key: 'delete', modifiers: ['ctrl', 'alt'],  description: 'Security screen' },
  { label: 'Ctrl+Shift+Esc',  key: 'escape', modifiers: ['ctrl', 'shift'], description: 'Task Manager' },
  { label: 'Alt+Tab',         key: 'tab',    modifiers: ['alt'],           description: 'Switch windows' },
  { label: 'Alt+F4',          key: 'f4',     modifiers: ['alt'],           description: 'Close window' },
  { label: 'Win+L',           key: 'l',      modifiers: ['win'],           description: 'Lock workstation' },
  { label: 'Win+R',           key: 'r',      modifiers: ['win'],           description: 'Run dialog' },
  { label: 'Win+E',           key: 'e',      modifiers: ['win'],           description: 'File Explorer' },
  { label: 'Win+D',           key: 'd',      modifiers: ['win'],           description: 'Show desktop' },
];

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
  pasteProgress,
  remapCmdCtrl,
  monitors,
  activeMonitor,
  audioEnabled,
  hasAudioTrack,
  onRemapCmdCtrlChange,
  onConfigChange,
  onBitrateChange,
  onSwitchMonitor,
  onToggleAudio,
  onSendKeys,
  onPasteAsKeystrokes,
  onCancelPaste,
  onDisconnect,
}: Props) {
  const MonitorIcon = Monitor as unknown as ComponentType<{ className?: string }>;
  const ConnectedIcon = Wifi as unknown as ComponentType<{ className?: string }>;
  const DisconnectedIcon = WifiOff as unknown as ComponentType<{ className?: string }>;
  const MinimizeIcon = Minimize as unknown as ComponentType<{ className?: string }>;
  const MaximizeIcon = Maximize as unknown as ComponentType<{ className?: string }>;
  const PowerIcon = Power as unknown as ComponentType<{ className?: string }>;
  const KeyboardIcon = Keyboard as unknown as ComponentType<{ className?: string }>;
  const PasteIcon = ClipboardPaste as unknown as ComponentType<{ className?: string }>;
  const ChevronDownIcon = ChevronDown as unknown as ComponentType<{ className?: string }>;
  const XIcon = X as unknown as ComponentType<{ className?: string }>;
  const SwapIcon = ArrowLeftRight as unknown as ComponentType<{ className?: string }>;
  const VolumeOnIcon = Volume2 as unknown as ComponentType<{ className?: string }>;
  const VolumeOffIcon = VolumeX as unknown as ComponentType<{ className?: string }>;

  const [isFullscreen, setIsFullscreen] = useState(!!document.fullscreenElement);
  const [duration, setDuration] = useState('0:00');
  const [keysOpen, setKeysOpen] = useState(false);
  const keysDropdownRef = useRef<HTMLDivElement>(null);

  // Update duration every second
  useEffect(() => {
    if (!connectedAt) return;
    const interval = setInterval(() => {
      setDuration(formatDuration(connectedAt));
    }, 1000);
    return () => clearInterval(interval);
  }, [connectedAt]);

  // Sync fullscreen state with browser (handles Escape key exit, etc.)
  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(!!document.fullscreenElement);
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!keysOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (keysDropdownRef.current && !keysDropdownRef.current.contains(e.target as Node)) {
        setKeysOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [keysOpen]);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
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
      {transport === 'webrtc' && (
        <div className="flex items-center gap-1.5">
          <label className="text-gray-400 text-xs">Max Bitrate</label>
          <input
            type="range"
            min="500"
            max="15000"
            step="250"
            value={bitrate}
            onChange={(e) => onBitrateChange(parseInt(e.target.value))}
            className="w-16 h-1 accent-green-500"
          />
          <span className="text-gray-400 text-xs w-12 tabular-nums">{bitrate >= 1000 ? `${(bitrate / 1000).toFixed(1)}M` : `${bitrate}K`}</span>
        </div>
      )}

      {/* WebSocket mode: Quality / Scale / FPS Limit */}
      {transport === 'websocket' && (
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

      {/* Monitor picker (only shown with 2+ monitors on WebRTC) */}
      {monitors.length > 1 && transport === 'webrtc' && (
        <>
          <div className="w-px h-5 bg-gray-600" />
          <div className="flex items-center gap-1.5">
            <MonitorIcon className="w-3.5 h-3.5 text-gray-400" />
            <select
              value={activeMonitor}
              onChange={(e) => onSwitchMonitor(parseInt(e.target.value))}
              className="bg-gray-700 text-gray-300 text-xs rounded px-1 py-0.5 border border-gray-600"
            >
              {monitors.map((m) => (
                <option key={m.index} value={m.index}>
                  {m.name || `Display ${m.index + 1}`}{m.isPrimary ? ' (Primary)' : ''}{m.width ? ` ${m.width}x${m.height}` : ''}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      <div className="flex-1" />

      {/* Paste progress indicator */}
      {pasteProgress && (
        <div className="flex items-center gap-1.5 text-xs text-yellow-400">
          <span>Pasting {pasteProgress.current}/{pasteProgress.total}</span>
          <button
            onClick={onCancelPaste}
            className="p-0.5 hover:bg-gray-700 rounded"
            title="Cancel paste"
          >
            <XIcon className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Audio toggle (only shown when agent has audio track) */}
      {hasAudioTrack && (
        <button
          onClick={onToggleAudio}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${
            audioEnabled
              ? 'text-green-400 bg-green-900/30 hover:bg-green-900/50'
              : 'text-gray-400 hover:text-white hover:bg-gray-700'
          }`}
          title={audioEnabled ? 'Mute remote audio' : 'Unmute remote audio'}
        >
          {audioEnabled ? <VolumeOnIcon className="w-3.5 h-3.5" /> : <VolumeOffIcon className="w-3.5 h-3.5" />}
          <span>Audio</span>
        </button>
      )}

      {/* Paste as Keystrokes */}
      <button
        onClick={onPasteAsKeystrokes}
        disabled={!!pasteProgress}
        className="flex items-center gap-1 px-2 py-1 text-xs text-gray-300 hover:text-white hover:bg-gray-700 rounded disabled:opacity-40 disabled:cursor-not-allowed"
        title="Paste clipboard text as keystrokes"
      >
        <PasteIcon className="w-3.5 h-3.5" />
        <span>Paste Text</span>
      </button>

      {/* Cmd↔Ctrl remap toggle */}
      <button
        onClick={() => onRemapCmdCtrlChange(!remapCmdCtrl)}
        className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${
          remapCmdCtrl
            ? 'text-green-400 bg-green-900/30 hover:bg-green-900/50'
            : 'text-gray-400 hover:text-white hover:bg-gray-700'
        }`}
        title={remapCmdCtrl ? 'Cmd↔Ctrl remap ON (click to disable)' : 'Cmd↔Ctrl remap OFF (click to enable)'}
      >
        <SwapIcon className="w-3.5 h-3.5" />
        <span>Cmd↔Ctrl</span>
      </button>

      {/* Send Keys dropdown */}
      <div className="relative" ref={keysDropdownRef}>
        <button
          onClick={() => setKeysOpen(!keysOpen)}
          className="flex items-center gap-1 px-2 py-1 text-xs text-gray-300 hover:text-white hover:bg-gray-700 rounded"
          title="Send key combination"
        >
          <KeyboardIcon className="w-3.5 h-3.5" />
          <span>Send Keys</span>
          <ChevronDownIcon className="w-3 h-3" />
        </button>

        {keysOpen && (
          <div className="absolute right-0 top-full mt-1 w-56 bg-gray-800 border border-gray-600 rounded-lg shadow-xl z-50 py-1">
            {KEY_COMBOS.map((combo) => (
              <button
                key={combo.label}
                onClick={() => {
                  onSendKeys(combo.key, combo.modifiers);
                  setKeysOpen(false);
                }}
                className="w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-gray-700 text-left"
              >
                <span className="text-gray-200 font-mono">{combo.label}</span>
                <span className="text-gray-500">{combo.description}</span>
              </button>
            ))}
          </div>
        )}
      </div>

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
