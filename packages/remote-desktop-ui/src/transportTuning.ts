import type { TransportCapabilities } from './transports/types';

/**
 * Whether the active transport exposes any stream-tuning controls, gating the
 * toolbar's "Quality" popover. WebRTC tunes bitrate (only when the session
 * advertises `bitrateControl`); WebSocket tunes quality/scale/FPS; VNC has none.
 *
 * Extracted from ViewerToolbar so the branch that decides whether users can
 * reach stream tuning at all is unit-tested, per the repo's lib-test pattern.
 */
export function transportHasQualityControls(
  transport: 'webrtc' | 'websocket' | 'vnc' | null,
  capabilities: TransportCapabilities | null | undefined,
): boolean {
  return Boolean(
    (capabilities?.bitrateControl && transport === 'webrtc') || transport === 'websocket',
  );
}
