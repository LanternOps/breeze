/**
 * Signaling client for the Breeze remote-desktop WebRTC flow.
 *
 * This replicates, over plain HTTP, exactly what the native Tauri viewer does
 * (see apps/viewer/src/lib/webrtc.ts) to bring up a desktop session:
 *
 *   1. POST /api/v1/auth/login                          -> admin access token
 *   2. POST /api/v1/remote/sessions                     -> create desktop session (sessionId)
 *   3. POST /api/v1/remote/sessions/:id/desktop-connect-code -> one-time connect code
 *   4. POST /api/v1/desktop-ws/connect/exchange         -> viewer access token (scoped to sessionId)
 *   5. GET  /api/v1/desktop-ws/:id/viewer/ice-servers   -> ICE servers (STUN/TURN)
 *   6. POST /api/v1/desktop-ws/:id/viewer/offer         -> submit SDP offer (triggers agent start_desktop)
 *   7. GET  /api/v1/desktop-ws/:id/viewer/session (poll)-> SDP answer from the agent
 *
 * Steps 1-4 use the standard bearer JWT; steps 5-7 use the short-lived *viewer*
 * token, which is what the offer/answer/ICE endpoints require.
 *
 * ICE is NON-trickle: the offer we POST already carries our gathered candidates
 * in its SDP, and the agent's answer carries its candidates. No separate
 * candidate-exchange endpoint is used (matches webrtc.ts).
 */

export interface SignalingConfig {
  /** e.g. http://localhost:32797/api/v1  (a bare origin also works). */
  baseUrl: string;
  adminEmail: string;
  adminPassword: string;
  deviceId: string;
}

/** werift's RTCIceServer requires `urls` to be a single string. */
export interface WeriftIceServer {
  urls: string;
  username?: string;
  credential?: string;
}

/** Derive the API origin (no trailing /api/v1) from a configured base URL. */
export function apiOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
}

async function postJson(
  url: string,
  body: unknown,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function getJson(url: string, token: string): Promise<Response> {
  return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
}

/** Step 1: admin login -> access token. */
export async function login(cfg: SignalingConfig): Promise<string> {
  const origin = apiOrigin(cfg.baseUrl);
  const res = await postJson(`${origin}/api/v1/auth/login`, {
    email: cfg.adminEmail,
    password: cfg.adminPassword,
  });
  if (!res.ok) {
    throw new Error(`login failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  }
  const data = (await res.json()) as { tokens?: { accessToken?: string } };
  const token = data.tokens?.accessToken;
  if (!token) throw new Error('login response missing tokens.accessToken');
  return token;
}

/** Step 2: create a desktop remote session, returns the sessionId. */
export async function createDesktopSession(
  cfg: SignalingConfig,
  accessToken: string,
): Promise<string> {
  const origin = apiOrigin(cfg.baseUrl);
  const res = await postJson(
    `${origin}/api/v1/remote/sessions`,
    { deviceId: cfg.deviceId, type: 'desktop' },
    accessToken,
  );
  if (!res.ok) {
    throw new Error(
      `create session failed: HTTP ${res.status} ${await res.text().catch(() => '')}`,
    );
  }
  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error('create-session response missing id');
  return data.id;
}

/**
 * Steps 3+4: mint a one-time desktop connect code, then exchange it for a
 * viewer access token scoped to this session (the token the viewer/offer/ICE
 * endpoints demand).
 */
export async function getViewerToken(
  cfg: SignalingConfig,
  accessToken: string,
  sessionId: string,
): Promise<string> {
  const origin = apiOrigin(cfg.baseUrl);

  const codeRes = await postJson(
    `${origin}/api/v1/remote/sessions/${sessionId}/desktop-connect-code`,
    {},
    accessToken,
  );
  if (!codeRes.ok) {
    throw new Error(
      `mint connect code failed: HTTP ${codeRes.status} ${await codeRes.text().catch(() => '')}`,
    );
  }
  const codeData = (await codeRes.json()) as { code?: string };
  if (!codeData.code) throw new Error('connect-code response missing code');

  const exchRes = await postJson(`${origin}/api/v1/desktop-ws/connect/exchange`, {
    sessionId,
    code: codeData.code,
  });
  if (!exchRes.ok) {
    throw new Error(
      `connect exchange failed: HTTP ${exchRes.status} ${await exchRes.text().catch(() => '')}`,
    );
  }
  const exchData = (await exchRes.json()) as { accessToken?: string };
  if (!exchData.accessToken) throw new Error('exchange response missing accessToken');
  return exchData.accessToken;
}

/** Step 5: fetch ICE servers, normalized to werift's single-string `urls` shape. */
export async function fetchIceServers(
  cfg: SignalingConfig,
  viewerToken: string,
  sessionId: string,
): Promise<WeriftIceServer[]> {
  const origin = apiOrigin(cfg.baseUrl);
  const fallback: WeriftIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  try {
    const res = await getJson(
      `${origin}/api/v1/desktop-ws/${sessionId}/viewer/ice-servers`,
      viewerToken,
    );
    if (!res.ok) return fallback;
    const data = (await res.json()) as {
      iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
    };
    if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) return fallback;
    // Flatten array-valued `urls` into one werift entry per URL.
    const out: WeriftIceServer[] = [];
    for (const s of data.iceServers) {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      for (const u of urls) {
        out.push({ urls: u, ...(s.username ? { username: s.username } : {}), ...(s.credential ? { credential: s.credential } : {}) });
      }
    }
    return out.length > 0 ? out : fallback;
  } catch {
    return fallback;
  }
}

/** Step 6: POST the SDP offer. Triggers the agent's start_desktop command. */
export async function postOffer(
  cfg: SignalingConfig,
  viewerToken: string,
  sessionId: string,
  offerSdp: string,
  displayIndex?: number,
): Promise<void> {
  const origin = apiOrigin(cfg.baseUrl);
  const res = await postJson(
    `${origin}/api/v1/desktop-ws/${sessionId}/viewer/offer`,
    { offer: offerSdp, ...(displayIndex != null ? { displayIndex } : {}) },
    viewerToken,
  );
  if (!res.ok) {
    throw new Error(
      `submit offer failed: HTTP ${res.status} ${await res.text().catch(() => '')}`,
    );
  }
}

/** Step 7: poll for the agent's SDP answer (or a failure status). */
export async function pollForAnswer(
  cfg: SignalingConfig,
  viewerToken: string,
  sessionId: string,
  timeoutMs = 15000,
  intervalMs = 100,
): Promise<string> {
  const origin = apiOrigin(cfg.baseUrl);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await getJson(
      `${origin}/api/v1/desktop-ws/${sessionId}/viewer/session`,
      viewerToken,
    );
    if (res.ok) {
      const data = (await res.json()) as {
        webrtcAnswer?: string | null;
        status?: string;
        errorMessage?: string | null;
      };
      if (data.webrtcAnswer) return data.webrtcAnswer;
      if (data.status === 'failed') {
        throw new Error(`agent reported session failure: ${data.errorMessage || 'unknown'}`);
      }
    } else if (res.status === 401) {
      throw new Error('viewer session ended/revoked while polling for answer (HTTP 401)');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for WebRTC answer from agent`);
}
