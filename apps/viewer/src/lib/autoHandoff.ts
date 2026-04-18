import type { TransportKind } from './transports/types';

export interface ShouldAutoHandoffInput {
  remoteOs: string | null;
  deviceId: string | undefined;
  currentTransport: TransportKind | null;
  desktopState: 'loginwindow' | 'user_session' | null;
  userJustSwitchedAt: number;
  now?: number;
  cooldownMs?: number;
}

export const DEFAULT_USER_CHOICE_COOLDOWN_MS = 60_000;

/**
 * Decides whether to auto-hand off to VNC. Returns `true` only when:
 * - the remote is macOS,
 * - a deviceId is known (so we can create tunnels),
 * - we are not already on VNC,
 * - the operator didn't just manually pick a transport within the cooldown window.
 *
 * Callers layer on the specific trigger (e.g., desktop_state:loginwindow or
 * WebRTC reconnect deadline expired).
 */
export function shouldAutoHandoffToVnc(input: ShouldAutoHandoffInput): boolean {
  const {
    remoteOs,
    deviceId,
    currentTransport,
    userJustSwitchedAt,
    now = Date.now(),
    cooldownMs = DEFAULT_USER_CHOICE_COOLDOWN_MS,
  } = input;

  if (remoteOs !== 'macos') return false;
  if (!deviceId) return false;
  if (currentTransport === 'vnc') return false;
  if (userJustSwitchedAt > 0 && now - userJustSwitchedAt < cooldownMs) return false;
  return true;
}

type DesktopAccessMode = 'user_session' | 'login_window' | 'unavailable';

export interface ShouldAutoHandoffToWebRTCInput {
  remoteOs: string | null;
  deviceId: string | undefined;
  currentTransport: TransportKind | null;
  userJustSwitchedAt: number;
  /** The previous value reported by pollDesktopAccess. Null means "not yet polled". */
  previousMode: DesktopAccessMode | null;
  /** The current value reported by pollDesktopAccess. */
  currentMode: DesktopAccessMode | null;
  now?: number;
  cooldownMs?: number;
}

/**
 * Decides whether to auto-hand off to WebRTC after a user logs in. Returns
 * true only when the mode *transitions* to `user_session` (first poll or
 * from another mode) and we are not already on WebRTC. Prevents looping
 * back-and-forth if the user intentionally stays on VNC after login.
 */
export function shouldAutoHandoffToWebRTC(input: ShouldAutoHandoffToWebRTCInput): boolean {
  const {
    remoteOs,
    deviceId,
    currentTransport,
    userJustSwitchedAt,
    previousMode,
    currentMode,
    now = Date.now(),
    cooldownMs = DEFAULT_USER_CHOICE_COOLDOWN_MS,
  } = input;

  if (remoteOs !== 'macos') return false;
  if (!deviceId) return false;
  if (currentTransport === 'webrtc') return false;
  if (userJustSwitchedAt > 0 && now - userJustSwitchedAt < cooldownMs) return false;
  if (currentMode !== 'user_session') return false;
  if (previousMode === 'user_session') return false;
  return true;
}
