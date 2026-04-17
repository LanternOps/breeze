export interface DesktopAccessSnapshot {
  mode: 'available' | 'unavailable';
  reason?: string;
  state?: 'loginwindow' | 'user_session';
  username?: string;
}

/**
 * Fetches the current desktop-access status for a device.
 * Returns null on any non-2xx response (e.g. 404 if the endpoint doesn't exist yet).
 * Callers should treat null as "unavailable" and keep polling.
 */
export async function getDesktopAccess(
  deviceId: string,
  auth: { apiUrl: string; accessToken: string },
): Promise<DesktopAccessSnapshot | null> {
  try {
    const res = await fetch(`${auth.apiUrl}/devices/${deviceId}/desktop-access`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (!res.ok) return null;
    return res.json() as Promise<DesktopAccessSnapshot>;
  } catch {
    return null;
  }
}
