import { useState, useEffect, useRef } from 'react';
import type { ComponentType } from 'react';
import { Monitor, Wifi, WifiOff, Maximize, Minimize, Keyboard, ClipboardPaste, ChevronDown, X, ArrowLeftRight, Volume2, VolumeX, MousePointer2, Check, Zap, MoreVertical, SlidersHorizontal } from 'lucide-react';
import type { TransportCapabilities } from '../lib/transports/types';
import { transportHasQualityControls } from '../lib/transportTuning';

interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  isPrimary: boolean;
}

interface Props {
  status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';
  hostname: string;
  connectedAt: Date | null;
  reconnectSecondsLeft?: number;
  fps: number;
  transport: 'webrtc' | 'websocket' | 'vnc' | null;
  quality: number;
  scale: number;
  maxFps: number;
  bitrate: number;
  pasteProgress: { current: number; total: number } | null;
  remapCmdCtrl: boolean;
  monitors: MonitorInfo[];
  activeMonitor: number;
  sessions: Array<{ sessionId: number; username: string; state: string; type: string; helperConnected: boolean }>;
  activeSessionId: number | null;
  onSwitchSession: (id: number) => void;
  audioEnabled: boolean;
  hasAudioTrack: boolean;
  showRemoteCursor: boolean;
  remoteOs: string | null;
  onRemapCmdCtrlChange: (v: boolean) => void;
  onShowRemoteCursorChange: (v: boolean) => void;
  onConfigChange: (quality: number, scale: number, maxFps: number) => void;
  onBitrateChange: (bitrate: number) => void;
  onSwitchMonitor: (index: number) => void;
  onToggleAudio: () => void;
  onSendKeys: (key: string, modifiers: string[]) => void;
  onSendSAS: () => void;
  onLockWorkstation: () => void;
  onPasteAsKeystrokes: () => void;
  onCancelPaste: () => void;
  /** True when a user session is active on the remote device and WebRTC is available (for Switch pill). */
  webRTCAvailable?: boolean;
  /** The logged-in username on the remote end (for Switch pill label). */
  remoteUserName?: string | null;
  /** Current desktop state from agent control-channel events. */
  desktopState?: { state: 'loginwindow' | 'user_session' | null; username: string | null };
  /** Called when the user clicks a transport option in the dropdown or Switch pill. */
  onSwitchTransport?: (target: 'webrtc' | 'vnc') => void;
  /** Capabilities of the active transport session; null = no session yet. */
  capabilities?: TransportCapabilities | null;
}

interface KeyCombo {
  label: string;
  key: string;
  modifiers: string[];
  description: string;
  action?: 'sas' | 'lock';
}

const WINDOWS_KEY_COMBOS: KeyCombo[] = [
  { label: 'Ctrl+Alt+Del',    key: 'delete', modifiers: ['ctrl', 'alt'],  description: 'Security screen', action: 'sas' },
  { label: 'Ctrl+Shift+Esc',  key: 'escape', modifiers: ['ctrl', 'shift'], description: 'Task Manager' },
  { label: 'Alt+Tab',         key: 'tab',    modifiers: ['alt'],           description: 'Switch windows' },
  { label: 'Alt+F4',          key: 'f4',     modifiers: ['alt'],           description: 'Close window' },
  { label: 'Win+L',           key: 'l',      modifiers: ['win'],           description: 'Lock workstation', action: 'lock' },
  { label: 'Win+R',           key: 'r',      modifiers: ['win'],           description: 'Run dialog' },
  { label: 'Win+E',           key: 'e',      modifiers: ['win'],           description: 'File Explorer' },
  { label: 'Win+D',           key: 'd',      modifiers: ['win'],           description: 'Show desktop' },
];

const MACOS_KEY_COMBOS: KeyCombo[] = [
  { label: 'Cmd+Opt+Esc',     key: 'escape', modifiers: ['cmd', 'alt'],           description: 'Force Quit' },
  { label: 'Cmd+Tab',         key: 'tab',    modifiers: ['cmd'],                  description: 'Switch apps' },
  { label: 'Cmd+W',           key: 'w',      modifiers: ['cmd'],                  description: 'Close window' },
  { label: 'Cmd+Q',           key: 'q',      modifiers: ['cmd'],                  description: 'Quit app' },
  { label: 'Cmd+Space',       key: 'space',  modifiers: ['cmd'],                  description: 'Spotlight' },
  { label: 'Cmd+Shift+3',     key: '3',      modifiers: ['cmd', 'shift'],         description: 'Screenshot' },
  { label: 'Ctrl+Cmd+Q',      key: 'q',      modifiers: ['ctrl', 'cmd'],          description: 'Lock screen' },
  { label: 'Cmd+Opt+D',       key: 'd',      modifiers: ['cmd', 'alt'],           description: 'Show/hide Dock' },
];

const LINUX_KEY_COMBOS: KeyCombo[] = [
  { label: 'Ctrl+Alt+Del',    key: 'delete', modifiers: ['ctrl', 'alt'],  description: 'System menu' },
  { label: 'Ctrl+Alt+T',      key: 't',      modifiers: ['ctrl', 'alt'],  description: 'Terminal' },
  { label: 'Alt+Tab',         key: 'tab',    modifiers: ['alt'],           description: 'Switch windows' },
  { label: 'Alt+F4',          key: 'f4',     modifiers: ['alt'],           description: 'Close window' },
  { label: 'Super+L',         key: 'l',      modifiers: ['win'],           description: 'Lock screen' },
  { label: 'Super+E',         key: 'e',      modifiers: ['win'],           description: 'File manager' },
];

function getKeyCombos(osType: string | null): KeyCombo[] {
  switch (osType) {
    case 'macos': return MACOS_KEY_COMBOS;
    case 'linux': return LINUX_KEY_COMBOS;
    case 'windows': case null: return WINDOWS_KEY_COMBOS;
    default:
      console.warn(`Unrecognized remote OS type "${osType}", falling back to Windows key combos`);
      return WINDOWS_KEY_COMBOS;
  }
}

function UserIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 14s-1 0-1-1 1-4 7-4 7 3 7 4-1 1-1 1H2Z" />
    </svg>
  );
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
  pasteProgress,
  remapCmdCtrl,
  monitors,
  activeMonitor,
  audioEnabled,
  hasAudioTrack,
  showRemoteCursor,
  remoteOs,
  onRemapCmdCtrlChange,
  onShowRemoteCursorChange,
  onConfigChange,
  onBitrateChange,
  onSwitchMonitor,
  sessions,
  activeSessionId,
  onSwitchSession,
  onToggleAudio,
  onSendKeys,
  onSendSAS,
  onLockWorkstation,
  onPasteAsKeystrokes,
  onCancelPaste,
  reconnectSecondsLeft,
  webRTCAvailable = false,
  remoteUserName = null,
  desktopState,
  onSwitchTransport,
  capabilities = null,
}: Props) {
  const MonitorIcon = Monitor as unknown as ComponentType<{ className?: string }>;
  const ConnectedIcon = Wifi as unknown as ComponentType<{ className?: string }>;
  const DisconnectedIcon = WifiOff as unknown as ComponentType<{ className?: string }>;
  const MinimizeIcon = Minimize as unknown as ComponentType<{ className?: string }>;
  const MaximizeIcon = Maximize as unknown as ComponentType<{ className?: string }>;
  const KeyboardIcon = Keyboard as unknown as ComponentType<{ className?: string }>;
  const PasteIcon = ClipboardPaste as unknown as ComponentType<{ className?: string }>;
  const ChevronDownIcon = ChevronDown as unknown as ComponentType<{ className?: string }>;
  const XIcon = X as unknown as ComponentType<{ className?: string }>;
  const SwapIcon = ArrowLeftRight as unknown as ComponentType<{ className?: string }>;
  const VolumeOnIcon = Volume2 as unknown as ComponentType<{ className?: string }>;
  const VolumeOffIcon = VolumeX as unknown as ComponentType<{ className?: string }>;
  const CursorIcon = MousePointer2 as unknown as ComponentType<{ className?: string }>;
  const CheckIcon = Check as unknown as ComponentType<{ className?: string }>;
  const ZapIcon = Zap as unknown as ComponentType<{ className?: string }>;
  const MoreIcon = MoreVertical as unknown as ComponentType<{ className?: string }>;
  const SlidersIcon = SlidersHorizontal as unknown as ComponentType<{ className?: string }>;

  // Transport label: a crisp lucide glyph + text, replacing emoji so the badge
  // matches the rest of the toolbar's monochrome icon vocabulary.
  const renderTransport = (t: 'webrtc' | 'vnc' | 'websocket' | null) => {
    if (t === 'webrtc') return (<><ZapIcon className="w-3 h-3" /><span>WebRTC</span></>);
    if (t === 'vnc') return (<><MonitorIcon className="w-3 h-3" /><span>VNC</span></>);
    return <span>WS</span>;
  };

  const [isFullscreen, setIsFullscreen] = useState(!!document.fullscreenElement);
  const [duration, setDuration] = useState('0:00');
  const [keysOpen, setKeysOpen] = useState(false);
  const [sasFlash, setSasFlash] = useState(false);
  const [transportDropdownOpen, setTransportDropdownOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [pillDismissed, setPillDismissed] = useState(false);
  const keysDropdownRef = useRef<HTMLDivElement>(null);
  const transportDropdownRef = useRef<HTMLDivElement>(null);
  const moreDropdownRef = useRef<HTMLDivElement>(null);
  const qualityDropdownRef = useRef<HTMLDivElement>(null);

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

  // Close keys dropdown when clicking outside
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

  // Close transport dropdown when clicking outside
  useEffect(() => {
    if (!transportDropdownOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (transportDropdownRef.current && !transportDropdownRef.current.contains(e.target as Node)) {
        setTransportDropdownOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [transportDropdownOpen]);

  // Close the overflow ("More") menu when clicking outside
  useEffect(() => {
    if (!moreOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (moreDropdownRef.current && !moreDropdownRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [moreOpen]);

  // Close the quality popover when clicking outside
  useEffect(() => {
    if (!qualityOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (qualityDropdownRef.current && !qualityDropdownRef.current.contains(e.target as Node)) {
        setQualityOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [qualityOpen]);

  // Close any open menu on Escape (keyboard escape from the toolbar)
  useEffect(() => {
    if (!keysOpen && !transportDropdownOpen && !moreOpen && !qualityOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setKeysOpen(false);
        setTransportDropdownOpen(false);
        setMoreOpen(false);
        setQualityOpen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [keysOpen, transportDropdownOpen, moreOpen, qualityOpen]);

  // Reset pill dismissed state when webRTCAvailable toggles off then back on
  useEffect(() => {
    if (!webRTCAvailable) {
      setPillDismissed(false);
    }
  }, [webRTCAvailable]);

  // Auto-dismiss the "Switch to WebRTC" pill after 30 seconds
  const showSwitchPill =
    transport === 'vnc' &&
    remoteOs === 'macos' &&
    webRTCAvailable &&
    !pillDismissed;

  useEffect(() => {
    if (!showSwitchPill) return;
    const timer = setTimeout(() => setPillDismissed(true), 30_000);
    return () => clearTimeout(timer);
  }, [showSwitchPill]);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (err) {
      console.warn('Fullscreen toggle failed:', err);
    }
  };

  const statusColor = {
    connecting: 'text-pending',
    connected: 'text-ok',
    reconnecting: 'text-retry',
    disconnected: 'text-gray-400',
    error: 'text-danger',
  }[status];

  const StatusIcon = status === 'connected' ? ConnectedIcon : DisconnectedIcon;

  const isWebRTC = transport === 'webrtc';

  // Whether the active transport exposes any stream-tuning controls (grouped
  // into the Quality popover so the bar isn't a row of loose sliders/selects).
  const hasQualityControls = transportHasQualityControls(transport, capabilities);

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 bg-gray-800 border-b border-gray-700 text-sm select-none">
      {/* Connection info */}
      <div className="flex items-center gap-2">
        <MonitorIcon className="w-4 h-4 text-gray-400" />
        <span className="text-gray-200 font-medium">{hostname || 'Connecting…'}</span>
        <StatusIcon className={`w-3.5 h-3.5 ${statusColor}`} />
        {connectedAt && (
          <span className="text-gray-500 text-xs">{duration}</span>
        )}
      </div>

      <div className="w-px h-5 bg-gray-600" />

      {/* Transport indicator — dropdown on macOS, static badge elsewhere */}
      {transport && (
        <>
          {remoteOs === 'macos' ? (
            <div className="relative" ref={transportDropdownRef}>
              <button
                onClick={() => setTransportDropdownOpen(!transportDropdownOpen)}
                className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium border ${
                  transport === 'webrtc'
                    ? 'bg-green-900/50 text-green-400 border-green-800 hover:bg-green-900/70'
                    : 'bg-blue-900/50 text-blue-400 border-blue-800 hover:bg-blue-900/70'
                }`}
                title="Switch transport"
              >
                <span className="flex items-center gap-1">{renderTransport(transport)}</span>
                <ChevronDownIcon className="w-3 h-3" />
              </button>

              {transportDropdownOpen && (
                <div className="absolute left-0 top-full mt-1 w-40 bg-gray-800 border border-gray-600 rounded-lg shadow-xl z-50 py-1">
                  {(['webrtc', 'vnc'] as const).map((opt) => {
                    const isActive = transport === opt;
                    const isLoginWindow = opt === 'webrtc' && desktopState?.state === 'loginwindow';
                    return (
                      <button
                        key={opt}
                        disabled={isActive || isLoginWindow}
                        onClick={() => {
                          if (!isActive && !isLoginWindow) {
                            onSwitchTransport?.(opt);
                          }
                          setTransportDropdownOpen(false);
                        }}
                        title={isLoginWindow ? 'WebRTC unavailable: device is at login window' : undefined}
                        className={`w-full flex items-center justify-between px-3 py-1.5 text-xs text-left ${
                          isActive
                            ? 'text-gray-200 cursor-default'
                            : isLoginWindow
                            ? 'text-gray-500 cursor-not-allowed'
                            : 'text-gray-300 hover:bg-gray-700'
                        }`}
                      >
                        <span className="flex items-center gap-1.5">{renderTransport(opt)}</span>
                        {isActive && <CheckIcon className="w-3 h-3 text-ok" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium ${
              isWebRTC
                ? 'bg-green-900/50 text-green-400 border border-green-800'
                : 'bg-blue-900/50 text-blue-400 border border-blue-800'
            }`}>
              {renderTransport(transport)}
            </span>
          )}

          {/* "Switch to WebRTC" pill — VNC + macOS + webRTCAvailable */}
          {showSwitchPill && (
            <div className="flex items-center gap-1 px-2 py-0.5 bg-green-900/40 border border-green-700 rounded text-xs text-green-300">
              <button
                onClick={() => {
                  onSwitchTransport?.('webrtc');
                  setPillDismissed(true);
                }}
                className="hover:text-green-100"
                title="Switch to WebRTC"
              >
                {remoteUserName ? `${remoteUserName} logged in — Switch to WebRTC` : 'User logged in — Switch to WebRTC'}
              </button>
              <button
                onClick={() => setPillDismissed(true)}
                className="ml-1 text-green-500 hover:text-green-200"
                title="Dismiss"
              >
                <XIcon className="w-3 h-3" />
              </button>
            </div>
          )}

          <div className="w-px h-5 bg-gray-600" />
        </>
      )}

      {/* FPS (read-only telemetry) */}
      <span className="text-gray-400 text-xs tabular-nums">{fps} FPS</span>

      {/* Quality popover — groups the per-transport stream tuning so the bar
          shows read-only telemetry, not a row of loose sliders and selects. */}
      {hasQualityControls && (
        <>
          <div className="w-px h-5 bg-gray-600" />
          <div className="relative" ref={qualityDropdownRef}>
            <button
              onClick={() => setQualityOpen(!qualityOpen)}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded ${
                qualityOpen ? 'text-white bg-gray-700' : 'text-gray-300 hover:text-white hover:bg-gray-700'
              }`}
              title="Stream quality"
              aria-haspopup="menu"
              aria-expanded={qualityOpen}
            >
              <SlidersIcon className="w-3.5 h-3.5" />
              <span>Quality</span>
              <ChevronDownIcon className="w-3 h-3" />
            </button>

            {qualityOpen && (
              <div role="menu" className="absolute left-0 top-full mt-1 w-60 bg-gray-800 border border-gray-600 rounded-lg shadow-xl z-50 p-3 flex flex-col gap-3">
                {/* WebRTC: Max bitrate */}
                {capabilities?.bitrateControl && transport === 'webrtc' && (
                  <label className="flex flex-col gap-1.5">
                    <span className="flex items-center justify-between text-gray-300 text-xs">
                      <span>Max bitrate</span>
                      <span className="text-gray-400 tabular-nums">
                        {bitrate >= 1000 ? `${(bitrate / 1000).toFixed(1)} Mbps` : `${bitrate} Kbps`}
                      </span>
                    </span>
                    <input
                      type="range"
                      min="500"
                      max="15000"
                      step="250"
                      value={bitrate}
                      onChange={(e) => onBitrateChange(parseInt(e.target.value))}
                      className="w-full h-1 accent-accent"
                    />
                  </label>
                )}

                {/* WebSocket: Quality / Scale / FPS limit */}
                {transport === 'websocket' && (
                  <>
                    <label className="flex flex-col gap-1.5">
                      <span className="flex items-center justify-between text-gray-300 text-xs">
                        <span>Quality</span>
                        <span className="text-gray-400 tabular-nums">{quality}</span>
                      </span>
                      <input
                        type="range"
                        min="10"
                        max="100"
                        step="5"
                        value={quality}
                        onChange={(e) => onConfigChange(parseInt(e.target.value), scale, maxFps)}
                        className="w-full h-1 accent-accent"
                      />
                    </label>

                    <label className="flex items-center justify-between gap-3 text-gray-300 text-xs">
                      <span>Scale</span>
                      <select
                        value={scale}
                        onChange={(e) => onConfigChange(quality, parseFloat(e.target.value), maxFps)}
                        className="bg-gray-700 text-gray-200 text-xs rounded px-2 py-1 border border-gray-600"
                      >
                        <option value={0.25}>25%</option>
                        <option value={0.5}>50%</option>
                        <option value={0.75}>75%</option>
                        <option value={1.0}>100%</option>
                      </select>
                    </label>

                    <label className="flex items-center justify-between gap-3 text-gray-300 text-xs">
                      <span>FPS limit</span>
                      <select
                        value={maxFps}
                        onChange={(e) => onConfigChange(quality, scale, parseInt(e.target.value))}
                        className="bg-gray-700 text-gray-200 text-xs rounded px-2 py-1 border border-gray-600"
                      >
                        <option value={5}>5</option>
                        <option value={10}>10</option>
                        <option value={15}>15</option>
                        <option value={20}>20</option>
                        <option value={30}>30</option>
                        <option value={60}>60</option>
                      </select>
                    </label>
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Monitor picker (only shown with 2+ monitors when transport supports it) */}
      {capabilities?.monitors && monitors.length > 1 && (
        <>
          <div className="w-px h-5 bg-gray-600" />
          <div className="flex items-center gap-1">
            {monitors.map((m) => (
              <button
                key={m.index}
                onClick={() => onSwitchMonitor(m.index)}
                title={`${m.name || `Display ${m.index + 1}`}${m.isPrimary ? ' (Primary)' : ''} ${m.width}x${m.height}`}
                className={`p-1 rounded transition-colors ${
                  activeMonitor === m.index
                    ? 'text-accent-soft bg-accent/20'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700'
                }`}
              >
                <span className="relative inline-flex items-center justify-center w-4 h-4">
                  <MonitorIcon className="w-4 h-4" />
                  <span className="absolute text-[7px] font-bold leading-none" style={{ marginTop: '-2px' }}>{m.index + 1}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Session picker dropdown (only shown with 2+ sessions when transport supports it) */}
      {capabilities?.sessionSwitch && sessions.length > 1 && (
        <>
          <div className="w-px h-5 bg-gray-600" />
          <div className="flex items-center gap-1.5">
            <UserIcon className="w-3 h-3 text-gray-400" />
            <select
              value={activeSessionId ?? ''}
              onChange={(e) => onSwitchSession(Number(e.target.value))}
              className="bg-gray-700 text-gray-300 text-xs rounded px-1 py-0.5 border border-gray-600"
            >
              {sessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.username || `Session ${s.sessionId}`}
                  {s.type === 'rdp' ? ' (RDP)' : ''}
                  {s.state === 'disconnected' ? ' - disconnected' : ''}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      <div className="flex-1" />

      {/* Reconnecting indicator */}
      {status === 'reconnecting' && reconnectSecondsLeft != null && (
        <span className="text-xs text-retry animate-pulse">
          Reconnecting… ({reconnectSecondsLeft}s)
        </span>
      )}

      {/* SAS sent flash */}
      {sasFlash && (
        <span className="text-xs text-pending animate-pulse">Ctrl+Alt+Del sent</span>
      )}

      {/* Paste progress indicator */}
      {pasteProgress && (
        <div className="flex items-center gap-1.5 text-xs text-pending">
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

      {/* Divider between status/telemetry and the primary action group */}
      <div className="w-px h-5 bg-gray-600" />

      {/* ── Primary actions: the controls a tech reaches for every session ── */}

      {/* Paste as Keystrokes */}
      <button
        onClick={onPasteAsKeystrokes}
        disabled={!!pasteProgress}
        className="flex items-center gap-1 px-2 py-1 text-xs text-gray-300 hover:text-white hover:bg-gray-700 rounded disabled:opacity-40 disabled:cursor-not-allowed"
        title="Paste clipboard text as keystrokes (Ctrl/Cmd+Shift+V)"
      >
        <PasteIcon className="w-3.5 h-3.5" />
        <span>Paste Text</span>
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
            {getKeyCombos(remoteOs)
              .filter((combo) => {
                // SAS requires sas capability; lock workstation also requires it (Windows only anyway)
                if (combo.action === 'sas' && !capabilities?.sas) return false;
                if (combo.action === 'lock' && !capabilities?.sas) return false;
                return true;
              })
              .map((combo) => (
                <button
                  key={combo.label}
                  onClick={() => {
                    switch (combo.action) {
                      case 'sas':
                        onSendSAS();
                        setSasFlash(true);
                        setTimeout(() => setSasFlash(false), 2000);
                        break;
                      case 'lock':
                        onLockWorkstation();
                        break;
                      default:
                        onSendKeys(combo.key, combo.modifiers);
                    }
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
        title={isFullscreen ? 'Exit fullscreen (Ctrl/Cmd+Shift+F)' : 'Fullscreen (Ctrl/Cmd+Shift+F)'}
      >
        {isFullscreen ? <MinimizeIcon className="w-4 h-4" /> : <MaximizeIcon className="w-4 h-4" />}
      </button>

      {/* ── Overflow menu: set-once session toggles ──────────────────────── */}
      <div className="w-px h-5 bg-gray-600" />
      <div className="relative" ref={moreDropdownRef}>
        <button
          onClick={() => setMoreOpen(!moreOpen)}
          className={`p-1 rounded ${moreOpen ? 'text-white bg-gray-700' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
          title="More options"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
        >
          <MoreIcon className="w-4 h-4" />
        </button>

        {moreOpen && (
          <div role="menu" className="absolute right-0 top-full mt-1 w-56 bg-gray-800 border border-gray-600 rounded-lg shadow-xl z-50 py-1">
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Session options</div>

            {/* Remote audio (only when the transport carries an audio track) */}
            {capabilities?.audio && hasAudioTrack && (
              <button
                role="menuitemcheckbox"
                aria-checked={audioEnabled}
                onClick={onToggleAudio}
                className="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-xs text-left text-gray-200 hover:bg-gray-700"
              >
                <span className="flex items-center gap-2">
                  {audioEnabled ? <VolumeOnIcon className="w-3.5 h-3.5" /> : <VolumeOffIcon className="w-3.5 h-3.5" />}
                  Remote audio
                </span>
                {audioEnabled && <CheckIcon className="w-3 h-3 text-accent-soft" />}
              </button>
            )}

            {/* Cmd↔Ctrl remap */}
            <button
              role="menuitemcheckbox"
              aria-checked={remapCmdCtrl}
              onClick={() => onRemapCmdCtrlChange(!remapCmdCtrl)}
              className="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-xs text-left text-gray-200 hover:bg-gray-700"
            >
              <span className="flex items-center gap-2">
                <SwapIcon className="w-3.5 h-3.5" />
                Cmd↔Ctrl remap
              </span>
              {remapCmdCtrl && <CheckIcon className="w-3 h-3 text-accent-soft" />}
            </button>

            {/* Remote cursor overlay (WebRTC only) */}
            <button
              role="menuitemcheckbox"
              aria-checked={showRemoteCursor}
              onClick={() => onShowRemoteCursorChange(!showRemoteCursor)}
              disabled={transport !== 'webrtc'}
              title={transport !== 'webrtc' ? 'Remote cursor overlay requires WebRTC' : undefined}
              className="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-xs text-left text-gray-200 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            >
              <span className="flex items-center gap-2">
                <CursorIcon className="w-3.5 h-3.5" />
                Remote cursor
              </span>
              {showRemoteCursor && transport === 'webrtc' && <CheckIcon className="w-3 h-3 text-accent-soft" />}
            </button>
          </div>
        )}
      </div>

    </div>
  );
}
