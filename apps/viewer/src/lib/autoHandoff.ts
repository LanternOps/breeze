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
