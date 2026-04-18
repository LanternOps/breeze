type DesktopAccessMode = 'user_session' | 'login_window' | 'unavailable';

export interface DesktopAccessPoll {
  /** Full desktop-access mode from the device record. Null when not reported. */
  mode: DesktopAccessMode | null;
  /** The logged-in username (from devices.lastUser), null otherwise. */
  username: string | null;
}

export type DesktopAccessPollResult =
  | { ok: true; poll: DesktopAccessPoll }
  | { ok: false; reason: 'unauthorized' | 'network' | 'error' };

interface DeviceDetailSubset {
  desktopAccess?: {
    mode?: DesktopAccessMode;
  } | null;
  lastUser?: string | null;
}

/**
 * Polls the device detail endpoint and returns a tagged result for the
 * VNC→WebRTC switch-available pill. The viewer calls this every 5s while
 * on VNC on a macOS device.
 *
 * Returns { ok: false, reason: 'unauthorized' } on 401/403 (token expired/revoked),
 * { ok: false, reason: 'error' } on other 4xx/5xx, and { ok: false, reason: 'network' }
 * on fetch errors. Callers should stop polling on 'unauthorized' and silently
 * retry on 'network'/'error'.
 */
/**
 * Hits the viewer-token-authed endpoint at `/api/v1/vnc-viewer/desktop-access`.
 * That endpoint scopes the lookup by the token's bound tunnelId, so the viewer
 * does not need to supply a deviceId and cannot observe unrelated devices.
 * Kept the `deviceId` arg for API symmetry with the previous version but it's
 * no longer sent over the wire.
 */
export async function pollDesktopAccess(
  _deviceId: string,
  auth: { apiUrl: string; accessToken: string },
): Promise<DesktopAccessPollResult> {
  try {
    const res = await fetch(`${auth.apiUrl}/api/v1/vnc-viewer/desktop-access`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'unauthorized' };
    }
    if (!res.ok) {
      return { ok: false, reason: 'error' };
    }
    const body = (await res.json()) as DeviceDetailSubset;
    return {
      ok: true,
      poll: {
        mode: body.desktopAccess?.mode ?? null,
        username: body.lastUser ?? null,
      },
    };
  } catch {
    return { ok: false, reason: 'network' };
  }
}
