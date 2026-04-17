export interface TunnelAuth {
  apiUrl: string;
  accessToken: string;
}

export interface VncTunnelInfo {
  tunnelId: string;
  wsUrl: string;
}

/**
 * Creates a VNC tunnel to the device and fetches a WS ticket in one call.
 * On ws-ticket failure, attempts to DELETE the dangling tunnel before throwing.
 */
export async function createVncTunnel(deviceId: string, auth: TunnelAuth): Promise<VncTunnelInfo> {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${auth.accessToken}`,
  };

  const tunnelRes = await fetch(`${auth.apiUrl}/tunnels`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ deviceId, type: 'vnc' }),
  });
  if (!tunnelRes.ok) {
    const err = await tunnelRes.json().catch(() => null) as { error?: string } | null;
    throw new Error(err?.error ?? `Tunnel create failed (${tunnelRes.status})`);
  }
  const { id: tunnelId } = await tunnelRes.json() as { id: string };

  const ticketRes = await fetch(`${auth.apiUrl}/tunnels/${tunnelId}/ws-ticket`, {
    method: 'POST',
    headers,
  });
  if (!ticketRes.ok) {
    await closeTunnel(tunnelId, auth);
    throw new Error(`Failed to get tunnel ws-ticket (${ticketRes.status})`);
  }
  const { ticket } = await ticketRes.json() as { ticket: string };

  const wsProtocol = auth.apiUrl.startsWith('https') ? 'wss' : 'ws';
  const wsHost = auth.apiUrl.replace(/^https?:\/\//, '');
  const wsUrl = `${wsProtocol}://${wsHost}/api/v1/tunnel-ws/${tunnelId}/ws?ticket=${ticket}`;

  return { tunnelId, wsUrl };
}

/**
 * Best-effort close. Swallows errors — callers invoke this from cleanup paths
 * where surfacing an error would just mask the real cleanup reason.
 */
export async function closeTunnel(tunnelId: string, auth: TunnelAuth): Promise<void> {
  try {
    await fetch(`${auth.apiUrl}/tunnels/${tunnelId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
  } catch {
    // Intentionally swallowed
  }
}
