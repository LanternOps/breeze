/**
 * WebRTC transport for remote desktop streaming.
 * Extracted from DesktopViewer.tsx — pure connection logic, no React.
 * React refs/state are threaded in via WebRTCDeps callbacks.
 */

import { createWebRTCSession, AgentSessionError, type AuthenticatedConnectionParams } from '../webrtc';
import type { TransportSession } from './types';
import { capabilitiesFor } from './types';

export interface WebRTCDeps {
  videoElement: HTMLVideoElement;
  cursorOverlayRef: { readonly current: HTMLDivElement | null };
  targetSessionId?: number;
  /** Ref-like objects passed in so the cursor handler reads current values at event time */
  showRemoteCursorRef: { current: boolean };
  remoteCursorShapeRef: { current: string };
  // Lifecycle callbacks — fire unconditionally; caller decides what to do
  onConnected: () => void;
  onDisconnected: () => void;
  onFailed: () => void;
  onClosed: () => void;
  // Tracks
  onAudioTrack: (audioEl: HTMLAudioElement) => void;
  // Data channels
  onClipboardChannel: (channel: RTCDataChannel) => void;
  onCursorChannelOpen: () => void;
  onCursorChannelClose: () => void;
}

export interface WebRTCSessionWrapper extends TransportSession {
  kind: 'webrtc';
  pc: RTCPeerConnection;
  videoElement: HTMLVideoElement;
  controlChannel: RTCDataChannel;
  inputChannel: RTCDataChannel;
}

export async function connectWebRTC(
  auth: AuthenticatedConnectionParams,
  deps: WebRTCDeps,
): Promise<WebRTCSessionWrapper | null> {
  const videoEl = deps.videoElement;

  try {
    const session = await createWebRTCSession(auth, videoEl, undefined, deps.targetSessionId);

    // Reduce input lag under loss: caller manages mouse-move coalescing via the
    // returned inputChannel, but set the low-water threshold here so it can hook
    // onbufferedamountlow after we return.
    try {
      session.inputChannel.bufferedAmountLowThreshold = 256 * 1024;
    } catch {
      // Some environments may not support this field.
    }

    // Handle audio tracks from the agent (WASAPI loopback).
    // pc.ontrack is already set by createWebRTCSession for the video track;
    // we wrap it to intercept audio tracks without breaking the video wiring.
    const origOnTrack = session.pc.ontrack;
    session.pc.ontrack = (event) => {
      // Call the original handler from webrtc.ts (wires video)
      if (origOnTrack) (origOnTrack as (ev: RTCTrackEvent) => void)(event);
      if (event.track.kind === 'audio') {
        // Create a dedicated Audio element for the remote audio track.
        // The video element's MediaStream (set up in webrtc.ts) only carries
        // the video track, so audio needs its own playback element.
        const audioEl = new Audio();
        audioEl.srcObject = new MediaStream([event.track]);
        audioEl.muted = true; // start muted (user toggles)
        audioEl.play().catch((err) => {
          console.warn('Failed to auto-play remote audio track:', err);
        });
        deps.onAudioTrack(audioEl);
      }
    };

    // Monitor connection state — callbacks fire unconditionally.
    // The caller (React component) decides whether to reconnect based on its
    // own guards (webrtcRef.current !== session, userDisconnectRef.current).
    session.pc.onconnectionstatechange = () => {
      const state = session.pc.connectionState;
      if (state === 'connected') {
        deps.onConnected();
      } else if (state === 'failed') {
        deps.onFailed();
      } else if (state === 'disconnected') {
        deps.onDisconnected();
      } else if (state === 'closed') {
        deps.onClosed();
      }
    };

    // Listen for agent-created data channels (cursor, clipboard)
    session.pc.ondatachannel = (event) => {
      if (event.channel.label === 'cursor') {
        event.channel.onopen = () => deps.onCursorChannelOpen();
        event.channel.onclose = () => deps.onCursorChannelClose();
        event.channel.onmessage = (msg) => {
          const overlay = deps.cursorOverlayRef.current;
          if (!overlay || !videoEl) return;

          try {
            const data = JSON.parse(msg.data);
            const { x, y, v, s } = data;

            // Update cursor shape when the agent sends a new shape.
            // "s" is only included when it differs from the last sent value.
            const VALID_CURSORS = new Set([
              'default', 'pointer', 'text', 'crosshair', 'move', 'grab', 'grabbing',
              'ew-resize', 'ns-resize', 'nwse-resize', 'nesw-resize', 'not-allowed',
              'wait', 'progress', 'help', 'context-menu', 'cell', 'none',
            ]);
            if (s && typeof s === 'string' && VALID_CURSORS.has(s)) {
              deps.remoteCursorShapeRef.current = s;
              // Apply CSS cursor to the video element immediately. When the
              // remote cursor overlay is hidden, the user's OS cursor adopts
              // the remote shape (text beam, pointer hand, resize arrows, etc.).
              if (!deps.showRemoteCursorRef.current) {
                videoEl.style.cursor = s;
              }
            }

            if (!deps.showRemoteCursorRef.current) {
              overlay.style.display = 'none';
              return;
            }

            if (!v) {
              overlay.style.display = 'none';
              return;
            }

            const videoW = videoEl.videoWidth;
            const videoH = videoEl.videoHeight;
            if (!videoW || !videoH) return;

            const rect = videoEl.getBoundingClientRect();
            const containerRect = overlay.parentElement?.getBoundingClientRect();
            if (!containerRect) return;

            // Same letterboxing math as scaleVideoCoords (remote→local)
            const videoAspect = videoW / videoH;
            const rectAspect = rect.width / rect.height;
            let displayW: number, displayH: number, offsetX: number, offsetY: number;
            if (rectAspect > videoAspect) {
              displayH = rect.height;
              displayW = rect.height * videoAspect;
              offsetX = (rect.width - displayW) / 2;
              offsetY = 0;
            } else {
              displayW = rect.width;
              displayH = rect.width / videoAspect;
              offsetX = 0;
              offsetY = (rect.height - displayH) / 2;
            }

            const remoteX = Math.max(0, Math.min(videoW - 1, Number(x) || 0));
            const remoteY = Math.max(0, Math.min(videoH - 1, Number(y) || 0));
            const localX = (remoteX / videoW) * displayW + offsetX + (rect.left - containerRect.left);
            const localY = (remoteY / videoH) * displayH + offsetY + (rect.top - containerRect.top);

            overlay.style.display = 'block';
            overlay.style.transform = `translate(${localX}px, ${localY}px)`;
          } catch (err) {
            console.debug('Cursor message handling failed:', err);
          }
        };
      } else if (event.channel.label === 'clipboard') {
        // Hand the channel to the caller — they install onmessage (needs Tauri clipboard write)
        deps.onClipboardChannel(event.channel);
      }
    };

    const wrapper: WebRTCSessionWrapper = {
      kind: 'webrtc',
      capabilities: capabilitiesFor('webrtc'),
      pc: session.pc,
      videoElement: videoEl,
      controlChannel: session.controlChannel,
      inputChannel: session.inputChannel,
      close: () => session.close(),
    };

    return wrapper;
  } catch (err) {
    // If the agent reported a session failure (e.g. capture unsupported,
    // no encoder), propagate it so the viewer shows the real error instead
    // of silently falling back to WebSocket which will also fail.
    if (err instanceof AgentSessionError) {
      throw err;
    }
    console.warn('WebRTC connection failed:', err);
    return null;
  }
}
