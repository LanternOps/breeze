import { describe, it, expect } from 'vitest';
import {
  WEBRTC_UNSUPPORTED_HINT,
  webrtcSwitchUnavailableReason,
  shouldShowWebRTCSwitchPill,
} from './transportAvailability';

// Issue #3410. Skipping WebRTC on a WebView that has none is only half a fix:
// the toolbar still offered the switch, and clicking it did nothing at all —
// quieter than the crash it replaced. These predicates gate those controls.

describe('webrtcSwitchUnavailableReason', () => {
  it('blocks the switch when the WebView has no WebRTC', () => {
    expect(
      webrtcSwitchUnavailableReason({ webrtcSupported: false, desktopState: 'user_session' }),
    ).toBe(WEBRTC_UNSUPPORTED_HINT);
  });

  it('still blocks at the login window when WebRTC is supported', () => {
    expect(
      webrtcSwitchUnavailableReason({ webrtcSupported: true, desktopState: 'loginwindow' }),
    ).toMatch(/login window/);
  });

  it('reports the WebView gap ahead of the login window — the WebView one is permanent', () => {
    expect(
      webrtcSwitchUnavailableReason({ webrtcSupported: false, desktopState: 'loginwindow' }),
    ).toBe(WEBRTC_UNSUPPORTED_HINT);
  });

  it('allows the switch when WebRTC works and a user is logged in', () => {
    expect(
      webrtcSwitchUnavailableReason({ webrtcSupported: true, desktopState: 'user_session' }),
    ).toBeNull();
  });

  it('allows the switch when desktop state is unknown', () => {
    expect(
      webrtcSwitchUnavailableReason({ webrtcSupported: true, desktopState: null }),
    ).toBeNull();
  });
});

describe('shouldShowWebRTCSwitchPill', () => {
  const offerable = {
    transport: 'vnc',
    remoteOs: 'macos',
    webRTCAvailable: true,
    webrtcSupported: true,
    pillDismissed: false,
  };

  it('offers the switch when the remote is ready and this WebView can do WebRTC', () => {
    expect(shouldShowWebRTCSwitchPill(offerable)).toBe(true);
  });

  it('never invites a click this WebView cannot honour', () => {
    // webRTCAvailable describes the REMOTE macOS device, so on its own it
    // actively invites a click that the switchTransport guard would swallow.
    expect(shouldShowWebRTCSwitchPill({ ...offerable, webrtcSupported: false })).toBe(false);
  });

  it.each([
    ['not on VNC', { transport: 'websocket' }],
    ['remote is not macOS', { remoteOs: 'windows' }],
    ['remote WebRTC not available', { webRTCAvailable: false }],
    ['already dismissed', { pillDismissed: true }],
  ])('stays hidden when %s', (_label, override) => {
    expect(shouldShowWebRTCSwitchPill({ ...offerable, ...override })).toBe(false);
  });
});
