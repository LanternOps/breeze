/**
 * WebRTC session management for remote desktop P2P streaming.
 * Uses H264 video track from the agent's pion peer connection.
 */

import { apiFetch } from './api';

export interface AuthenticatedConnectionParams {
  sessionId: string;
  apiUrl: string;
  accessToken: string;
}

export interface WebRTCSession {
  pc: RTCPeerConnection;
  inputChannel: RTCDataChannel;
  controlChannel: RTCDataChannel;
  close: () => void;
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
): Promise<WebRTCSession> {
  // Fetch ICE servers (includes TURN credentials if configured)
  let iceServers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  try {
    const iceResp = await apiFetch(
      params.apiUrl,
      '/api/v1/remote/ice-servers',
      params.accessToken,
    );
    if (iceResp.ok) {
      const iceData = await iceResp.json();
      if (Array.isArray(iceData.iceServers) && iceData.iceServers.length > 0) {
        iceServers = iceData.iceServers;
      }
    }
  } catch {
    // Fall back to STUN only
  }

  const pc = new RTCPeerConnection({ iceServers });

  // Receive-only video transceiver (agent sends H264 video track)
  pc.addTransceiver('video', { direction: 'recvonly' });

  // DataChannels for input events and control messages
  const inputChannel = pc.createDataChannel('input', { ordered: true });
  const controlChannel = pc.createDataChannel('control', { ordered: true });

  // Wire incoming video track to the <video> element
  pc.ontrack = (event) => {
    if (event.track.kind === 'video' && event.streams[0]) {
      videoEl.srcObject = event.streams[0];
    }
  };

  // Create offer and wait for ICE gathering to complete
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  await waitForIceGathering(pc, 5000);

  const localDesc = pc.localDescription;
  if (!localDesc?.sdp) {
    pc.close();
    throw new Error('Failed to generate local SDP');
  }

  // POST offer to API — this triggers the agent to create a pion session
  const offerResp = await apiFetch(
    params.apiUrl,
    `/api/v1/remote/sessions/${params.sessionId}/offer`,
    params.accessToken,
    {
      method: 'POST',
      body: JSON.stringify({ offer: localDesc.sdp }),
    },
  );

  if (!offerResp.ok) {
    pc.close();
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
    close: () => {
      inputChannel.close();
      controlChannel.close();
      pc.close();
    },
  };
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
 */
async function pollForAnswer(params: AuthenticatedConnectionParams, timeoutMs: number): Promise<string> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const resp = await apiFetch(
      params.apiUrl,
      `/api/v1/remote/sessions/${params.sessionId}`,
      params.accessToken,
    );

    if (resp.ok) {
      const data = await resp.json();
      if (data.webrtcAnswer) {
        return data.webrtcAnswer;
      }
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error('Timed out waiting for WebRTC answer from agent');
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

  return {
    x: Math.max(0, Math.min(videoW, Math.round((relX * videoW) / displayW))),
    y: Math.max(0, Math.min(videoH, Math.round((relY * videoH) / displayH))),
  };
}
