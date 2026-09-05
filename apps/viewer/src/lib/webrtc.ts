/**
 * WebRTC session management for remote desktop P2P streaming.
 * Uses H264 video track from the agent's pion peer connection.
 */

import { apiFetch } from './api';

/**
 * Error thrown when the remote agent reports a session failure
 * (e.g. screen capture unsupported, no H264 encoder).
 * Distinguished from local WebRTC setup errors so callers can
 * avoid futile fallback attempts.
 */
export class AgentSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSessionError';
  }
}

/**
 * Error thrown when the server rejects access to the session because it has
 * already ended (HTTP 401 'Session ended' from the mid-session revocation
 * guard — see Finding #5). The single-session viewer token can never connect
 * to this session again, so callers MUST stop retrying the same sessionId and
 * surface a terminal "session ended" state rather than hammering the endpoint.
 */
export class SessionEndedError extends Error {
  constructor(message = 'This remote session has ended.') {
    super(message);
    this.name = 'SessionEndedError';
  }
}

/**
 * Every 401 on the viewer offer/poll path is terminal.
 *
 * A viewer token authorizes exactly one still-live session, so once the server
 * starts 401ing there is nothing a retry can recover — it has already decided
 * the token, its JTI, or the session itself is no longer valid.
 *
 * This deliberately does NOT inspect the response body. It used to match on the
 * text ("session ended"/"revoked"/"no longer active"), which silently missed
 * most of the 401s the API actually returns — `Session closed`, `Missing viewer
 * token`, `Invalid or expired viewer token` — so the answer poll kept hammering
 * a dead session until it timed out, burning the caller's per-IP rate-limit
 * budget and 429ing the operator's own dashboard (issue #3041). Status alone is
 * the reliable signal; matching prose is not.
 */
export function isSessionEndedResponse(status: number): boolean {
  return status === 401;
}

/**
 * True when a response status means this connection attempt can never succeed,
 * so repeating the identical request is pure wasted load.
 *
 * Any 4xx qualifies except the two that explicitly invite a retry — 408
 * (request timeout) and 429 (rate limited). Everything else the viewer
 * endpoints return (400 not-a-desktop-session, 403 policy-denied or
 * owner-mismatch, 404 session-not-found) reflects session, token, or policy
 * state that the next poll cannot change. 401 is terminal too, but callers
 * check {@link isSessionEndedResponse} first so it surfaces as the dedicated
 * SessionEndedError.
 */
export function isUnretryableViewerStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Retry-After as milliseconds, or null when absent/unparseable. Only the
 * delta-seconds form is honoured — that's what the API emits.
 */
export function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

/**
 * Error thrown when this WebView has no WebRTC implementation at all, so no
 * amount of retrying or re-signalling can ever produce a peer connection.
 * Distinguished from a *failed* connection attempt: callers should fall
 * straight through to the WebSocket transport and tell the user why, rather
 * than treating it as a transient error worth another attempt.
 */
export class WebRTCUnsupportedError extends Error {
  constructor(
    message = 'WebRTC is not available in this WebView, so remote desktop cannot use the WebRTC transport.',
  ) {
    super(message);
    this.name = 'WebRTCUnsupportedError';
  }
}

/**
 * Whether this WebView can construct an RTCPeerConnection at all.
 *
 * The Linux Viewer is a Tauri app rendered by webkit2gtk. Whether that build
 * exposes WebRTC depends entirely on how the distro compiled webkit2gtk and
 * whether the matching GStreamer plugins are installed — on a fair number of
 * builds `RTCPeerConnection` is simply not a global. Reading it as a bare
 * identifier would itself throw a ReferenceError there, so this MUST stay a
 * `typeof` check against the global object (issue #3410).
 */
export function isWebRTCSupported(): boolean {
  return typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection === 'function';
}

export interface AuthenticatedConnectionParams {
  sessionId: string;
  apiUrl: string;
  accessToken: string;
  /** Device UUID — required for VNC tunnel creation and desktop-access polling. */
  deviceId?: string;
}

export interface WebRTCSession {
  pc: RTCPeerConnection;
  inputChannel: RTCDataChannel;
  controlChannel: RTCDataChannel;
  close: () => void;
}

const ICE_GATHER_TIMEOUT_MS = 3000;

/**
 * Fallback ICE configuration. Used both when the ICE-servers endpoint is
 * unreachable and as the known-good config `createPeerConnection` retries with
 * before concluding a WebView cannot do WebRTC at all.
 */
const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Answer-poll pacing. The poll starts tight so a healthy agent (which answers
 * within a few hundred ms) is still picked up almost immediately, then backs
 * off geometrically so a slow or dead session doesn't turn the 15s window into
 * ~300 requests. With these values a full 15s wait costs ~35 requests instead,
 * which matters because those requests are metered against the caller's IP
 * (issue #3041).
 */
export const ANSWER_POLL_INITIAL_INTERVAL_MS = 50;
export const ANSWER_POLL_MAX_INTERVAL_MS = 500;
const ANSWER_POLL_BACKOFF_FACTOR = 1.5;

/** Next answer-poll delay, geometric up to the cap. */
export function nextAnswerPollInterval(currentMs: number): number {
  return Math.min(
    Math.round(currentMs * ANSWER_POLL_BACKOFF_FACTOR),
    ANSWER_POLL_MAX_INTERVAL_MS,
  );
}

/**
 * One attempt at a peer connection plus its two data channels, propagating any
 * failure as-is. Callers classify; this only guarantees it leaves nothing open.
 */
function buildPeerConnection(iceServers: RTCIceServer[]): {
  pc: RTCPeerConnection;
  inputChannel: RTCDataChannel;
  controlChannel: RTCDataChannel;
} {
  let pc: RTCPeerConnection | undefined;
  try {
    pc = new RTCPeerConnection({ iceServers });

    // Receive-only video transceiver (agent sends H264 video track)
    pc.addTransceiver('video', { direction: 'recvonly' });

    // DataChannels for input events and control messages.
    // Input uses ordered + unreliable delivery: ordered ensures mouse_down →
    // mouse_move → mouse_up arrive in sequence (required for drag operations),
    // maxRetransmits: 0 keeps latency low by skipping retransmission of lost packets.
    const inputChannel = pc.createDataChannel('input', { ordered: true, maxRetransmits: 0 });
    const controlChannel = pc.createDataChannel('control', { ordered: true });
    return { pc, inputChannel, controlChannel };
  } catch (err) {
    // Don't strand a half-built connection. createWebRTCSession's `close()` is
    // not defined until after the channels exist, so a throw from
    // addTransceiver/createDataChannel used to leak an open pc.
    try { pc?.close(); } catch { /* already failing — nothing to salvage */ }
    throw err;
  }
}

/**
 * Build the peer connection, classifying a failure this WebView can never
 * recover from as {@link WebRTCUnsupportedError}.
 *
 * `isWebRTCSupported()` catches the WebViews where `RTCPeerConnection` is not a
 * global at all, but that is only the blunter half of the problem: a webkit2gtk
 * build missing its GStreamer WebRTC plugins commonly *exposes* the constructor
 * and then throws when you actually use it. Left unclassified, that resurfaced
 * as a generic "WebRTC connection failed" — retryable-looking, and it suppressed
 * the notice that tells the operator why quality dropped (issue #3410).
 */
function createPeerConnection(iceServers: RTCIceServer[]): {
  pc: RTCPeerConnection;
  inputChannel: RTCDataChannel;
  controlChannel: RTCDataChannel;
} {
  try {
    return buildPeerConnection(iceServers);
  } catch (firstErr) {
    // The ICE list comes from the API and is only checked for being a non-empty
    // array — a malformed `urls` or a TURN entry without credentials makes the
    // constructor throw per spec. That is a server-config fault, not a missing
    // WebRTC implementation, and calling it the latter would send an admin
    // chasing GStreamer over a TURN typo (and, once the UI latches the
    // capability, permanently disable WebRTC over one bad row).
    //
    // So prove it against a config we know is well-formed before blaming the
    // WebView. If STUN-only also fails, the implementation really is absent.
    //
    // Log first, and unconditionally: when the retry SUCCEEDS this is the only
    // trace that the operator's ICE config was rejected. The session then runs
    // without the configured TURN relay, so on a symmetric-NAT or restrictive
    // network it will still fail at ICE — and without this line that surfaces
    // as a generic "WebRTC connection failed" with the real cause never named.
    console.warn(
      'ICE servers from the API were rejected by RTCPeerConnection; retrying STUN-only. ' +
        'TURN relay is disabled for this session — check the ice-servers response:',
      firstErr,
    );
    try {
      return buildPeerConnection([...DEFAULT_ICE_SERVERS]);
    } catch (retryErr) {
      const cause = retryErr instanceof Error ? retryErr.message : String(retryErr);
      throw new WebRTCUnsupportedError(
        `This WebView could not create a WebRTC peer connection: ${cause}. On Linux ` +
          'this usually means the webkit2gtk build is missing its GStreamer WebRTC plugins.',
      );
    }
  }
}

/**
 * Create a WebRTC session with the remote agent.
 *
 * Flow:
 * 1. Create RTCPeerConnection + recvonly video transceiver
 * 2. Create input/control DataChannels
 * 3. Generate offer, wait for ICE gathering
 * 4. POST offer to API (triggers start_desktop command to agent)
 * 5. Poll for answer (agent creates pion PeerConnection and returns SDP answer)
 * 6. Set remote description → ICE completes → video flows
 */
export async function createWebRTCSession(
  params: AuthenticatedConnectionParams,
  videoEl: HTMLVideoElement,
  displayIndex?: number,
  targetSessionId?: number,
): Promise<WebRTCSession> {
  // Bail out before any network work when the WebView has no WebRTC at all.
  // This must come first: the ICE-servers request below would otherwise burn a
  // round trip (and a rate-limit slot) fetching TURN credentials for a peer
  // connection that can never be constructed (issue #3410).
  if (!isWebRTCSupported()) {
    throw new WebRTCUnsupportedError();
  }

  // Fetch ICE servers (includes TURN credentials if configured)
  let iceServers: RTCIceServer[] = [...DEFAULT_ICE_SERVERS];
  try {
    const iceResp = await apiFetch(
      params.apiUrl,
      `/api/v1/desktop-ws/${params.sessionId}/viewer/ice-servers`,
      params.accessToken,
    );
    if (iceResp.ok) {
      const iceData = await iceResp.json();
      if (Array.isArray(iceData.iceServers) && iceData.iceServers.length > 0) {
        iceServers = iceData.iceServers;
      }
    }
  } catch (error) {
    console.warn('Failed to fetch ICE servers, falling back to STUN-only:', error);
  }

  const { pc, inputChannel, controlChannel } = createPeerConnection(iceServers);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { inputChannel.close(); } catch { /* ignore */ }
    try { controlChannel.close(); } catch { /* ignore */ }
    try { pc.close(); } catch { /* ignore */ }
  };

  try {
    // Wire incoming video track to the <video> element
    pc.ontrack = (event) => {
      if (event.track.kind === 'video' && event.streams[0]) {
        videoEl.srcObject = event.streams[0];

        // Minimize jitter buffer for low-latency screen sharing.
        // Chrome 109+ / Firefox 120+ support jitterBufferTarget on RTCRtpReceiver.
        const receiver = event.receiver;
        if (receiver && 'jitterBufferTarget' in receiver) {
          (receiver as any).jitterBufferTarget = 0;
        }
      }
    };

    // Create offer and wait for ICE gathering to complete
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await waitForIceGathering(pc, ICE_GATHER_TIMEOUT_MS);

    const localDesc = pc.localDescription;
    if (!localDesc?.sdp) {
      throw new Error('Failed to generate local SDP');
    }

    // POST offer to API — this triggers the agent to create a pion session
    const offerResp = await apiFetch(
      params.apiUrl,
      `/api/v1/desktop-ws/${params.sessionId}/viewer/offer`,
      params.accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ offer: localDesc.sdp, ...(displayIndex != null ? { displayIndex } : {}), ...(targetSessionId != null ? { targetSessionId } : {}) }),
      },
    );

    if (!offerResp.ok) {
      // A 401 here means the session was ended/revoked server-side — retrying
      // the same sessionId is futile (Finding #5). Surface a terminal error.
      if (isSessionEndedResponse(offerResp.status)) {
        throw new SessionEndedError();
      }
      const msg = await offerResp.text().catch(() => 'unknown error');
      throw new Error(`Failed to submit WebRTC offer: ${msg}`);
    }

    // Poll for the answer (agent processes offer and returns SDP answer)
    const answerSdp = await pollForAnswer(params, 15000);

    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: 'answer', sdp: answerSdp }),
    );

    return {
      pc,
      inputChannel,
      controlChannel,
      close,
    };
  } catch (err) {
    close();
    throw err;
  }
}

/**
 * Wait for ICE gathering to complete (all candidates collected).
 */
function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      // Resolve even if not complete — partial candidates are OK
      resolve();
    }, timeoutMs);

    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    };
  });
}

/**
 * Poll GET /remote/sessions/:id until webrtcAnswer is populated.
 * Also checks for session failure so the viewer sees agent-side errors
 * immediately instead of waiting for the full timeout.
 */
async function pollForAnswer(params: AuthenticatedConnectionParams, timeoutMs: number): Promise<string> {
  const start = Date.now();
  let intervalMs = ANSWER_POLL_INITIAL_INTERVAL_MS;
  // Remembered so a timeout can say WHY it timed out. Without this a server
  // returning 503 for 15s is indistinguishable from an agent that never
  // answered, and both produce the same misleading "agent didn't respond".
  let lastErrorStatus: number | null = null;

  while (Date.now() - start < timeoutMs) {
    const resp = await apiFetch(
      params.apiUrl,
      `/api/v1/desktop-ws/${params.sessionId}/viewer/session`,
      params.accessToken,
    );

    if (resp.ok) {
      const data = await resp.json();
      // A terminal failure takes precedence over an answer from an earlier
      // attempt on this session. Never reconnect using stale signaling data.
      if (data.status === 'failed') {
        throw new AgentSessionError(data.errorMessage || 'Remote desktop failed to start on agent');
      }
      if (data.webrtcAnswer) {
        return data.webrtcAnswer;
      }
    } else if (isSessionEndedResponse(resp.status)) {
      // Session ended/revoked server-side mid-poll — stop immediately so the
      // caller can surface a terminal state instead of polling to timeout
      // and then retrying the same dead session (Finding #5).
      throw new SessionEndedError();
    } else if (isUnretryableViewerStatus(resp.status)) {
      // 400/403/404: the session, token, or policy state rules this attempt
      // out. Fail now rather than spending the rest of the window re-asking a
      // question the server has already answered.
      const detail = (await resp.text().catch(() => ''))?.trim();
      throw new Error(
        `Remote session rejected (${resp.status})${detail ? `: ${detail}` : ''}`,
      );
    } else if (resp.status === 429) {
      // The server has explicitly told us to back off. Honour Retry-After, and
      // if it outlasts the window we're willing to wait, stop rather than keep
      // adding load to a bucket we've already exhausted.
      const retryAfterMs = parseRetryAfterMs(resp.headers.get('Retry-After'));
      const remainingMs = timeoutMs - (Date.now() - start);
      if (retryAfterMs !== null && retryAfterMs >= remainingMs) {
        throw new Error('Remote session is rate limited — please retry in a moment.');
      }
      intervalMs = Math.max(retryAfterMs ?? 0, ANSWER_POLL_MAX_INTERVAL_MS);
    } else {
      // 5xx/408 — genuinely transient, so keep polling. Log the first of each
      // kind so a real outage is visible rather than silently absorbed into a
      // generic timeout 15s later.
      if (resp.status !== lastErrorStatus) {
        console.warn(`Answer poll got HTTP ${resp.status}; retrying until timeout`);
      }
    }

    if (!resp.ok) lastErrorStatus = resp.status;

    await new Promise((r) => setTimeout(r, intervalMs));
    intervalMs = nextAnswerPollInterval(intervalMs);
  }

  throw new Error(
    lastErrorStatus === null
      ? 'Timed out waiting for WebRTC answer from agent'
      : `Timed out waiting for WebRTC answer from agent (last response: HTTP ${lastErrorStatus})`,
  );
}

/**
 * Map mouse coordinates from a <video> element to remote screen coordinates.
 * Accounts for object-fit: contain letterboxing.
 */
export function scaleVideoCoords(
  clientX: number,
  clientY: number,
  videoEl: HTMLVideoElement,
): { x: number; y: number } {
  const rect = videoEl.getBoundingClientRect();
  const videoW = videoEl.videoWidth;
  const videoH = videoEl.videoHeight;

  if (!videoW || !videoH) return { x: 0, y: 0 };

  const videoAspect = videoW / videoH;
  const rectAspect = rect.width / rect.height;

  let displayW: number, displayH: number, offsetX: number, offsetY: number;

  if (rectAspect > videoAspect) {
    // Black bars on left/right
    displayH = rect.height;
    displayW = rect.height * videoAspect;
    offsetX = (rect.width - displayW) / 2;
    offsetY = 0;
  } else {
    // Black bars on top/bottom
    displayW = rect.width;
    displayH = rect.width / videoAspect;
    offsetX = 0;
    offsetY = (rect.height - displayH) / 2;
  }

  const relX = clientX - rect.left - offsetX;
  const relY = clientY - rect.top - offsetY;
  const maxX = Math.max(0, videoW - 1);
  const maxY = Math.max(0, videoH - 1);

  return {
    x: Math.max(0, Math.min(maxX, Math.round((relX * videoW) / displayW))),
    y: Math.max(0, Math.min(maxY, Math.round((relY * videoH) / displayH))),
  };
}
