type DesktopAccessMode = 'user_session' | 'login_window' | 'unavailable';

export interface DesktopAccessPoll {
  /** Full desktop-access mode from the device record. Null when not reported. */
  mode: DesktopAccessMode | null;
  /** The logged-in username (from devices.lastUser), null otherwise. */
  username: string | null;
}

interface DeviceDetailSubset {
  desktopAccess?: {
    mode?: DesktopAccessMode;
  } | null;
  lastUser?: string | null;
}

/**
 * Polls the device detail endpoint and returns a minimal snapshot for the
 * VNC→WebRTC switch-available pill. The viewer calls this every 5s while
 * on VNC on a macOS device.
 *
 * Returns null on network error or 4xx/5xx — callers should treat null as
 * "no update" rather than "webrtc unavailable".
 */
export async function pollDesktopAccess(
  deviceId: string,
  auth: { apiUrl: string; accessToken: string },
): Promise<DesktopAccessPoll | null> {
  try {
    const res = await fetch(`${auth.apiUrl}/devices/${deviceId}`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as DeviceDetailSubset;
    return {
      mode: body.desktopAccess?.mode ?? null,
      username: body.lastUser ?? null,
    };
  } catch {
    return null;
  }
}
