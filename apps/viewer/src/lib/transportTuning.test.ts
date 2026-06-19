import { describe, it, expect } from 'vitest';
import { transportHasQualityControls } from './transportTuning';
import { capabilitiesFor } from './transports/types';

describe('transportHasQualityControls', () => {
  it('is true for WebRTC when the session advertises bitrate control', () => {
    expect(transportHasQualityControls('webrtc', capabilitiesFor('webrtc'))).toBe(true);
  });

  it('is false for WebRTC without bitrate control (or no capabilities yet)', () => {
    expect(
      transportHasQualityControls('webrtc', { ...capabilitiesFor('webrtc'), bitrateControl: false }),
    ).toBe(false);
    expect(transportHasQualityControls('webrtc', null)).toBe(false);
    expect(transportHasQualityControls('webrtc', undefined)).toBe(false);
  });

  it('is true for WebSocket regardless of capabilities', () => {
    expect(transportHasQualityControls('websocket', null)).toBe(true);
    expect(transportHasQualityControls('websocket', capabilitiesFor('websocket'))).toBe(true);
  });

  it('is false for VNC and for no transport', () => {
    expect(transportHasQualityControls('vnc', capabilitiesFor('vnc'))).toBe(false);
    // VNC never has bitrate control, so even a forged true stays false:
    expect(transportHasQualityControls('vnc', { ...capabilitiesFor('vnc'), bitrateControl: true })).toBe(false);
    expect(transportHasQualityControls(null, null)).toBe(false);
  });

  it('returns a strict boolean, never undefined (used directly in JSX guards)', () => {
    expect(transportHasQualityControls('webrtc', null)).toBe(false);
    expect(typeof transportHasQualityControls('webrtc', null)).toBe('boolean');
  });
});
