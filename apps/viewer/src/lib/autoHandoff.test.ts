import { describe, it, expect } from 'vitest';
import { shouldAutoHandoffToVnc, shouldAutoHandoffToWebRTC } from './autoHandoff';

describe('shouldAutoHandoffToVnc', () => {
  const base = {
    remoteOs: 'macos',
    deviceId: 'dev-1',
    currentTransport: 'webrtc' as const,
    desktopState: null,
    userJustSwitchedAt: 0,
    now: 1_000_000,
  };

  it('returns true when on webrtc, mac, deviceId present, no recent user choice', () => {
    expect(shouldAutoHandoffToVnc(base)).toBe(true);
  });

  it('returns false when remote is not macOS', () => {
    expect(shouldAutoHandoffToVnc({ ...base, remoteOs: 'windows' })).toBe(false);
    expect(shouldAutoHandoffToVnc({ ...base, remoteOs: null })).toBe(false);
  });

  it('returns false when deviceId is missing', () => {
    expect(shouldAutoHandoffToVnc({ ...base, deviceId: undefined })).toBe(false);
  });

  it('returns false when already on VNC', () => {
    expect(shouldAutoHandoffToVnc({ ...base, currentTransport: 'vnc' })).toBe(false);
  });

  it('returns false during user-choice cooldown window', () => {
    expect(shouldAutoHandoffToVnc({
      ...base,
      userJustSwitchedAt: 1_000_000 - 30_000, // 30s ago
    })).toBe(false);
  });

  it('returns true after the user-choice cooldown window expires', () => {
    expect(shouldAutoHandoffToVnc({
      ...base,
      userJustSwitchedAt: 1_000_000 - 60_001, // 60.001s ago
    })).toBe(true);
  });

  it('returns false when on websocket transport (non-macOS concept, but guards explicit)', () => {
    // Webrtc or webSocket are the same — only vnc should short-circuit. Verify explicit ≠ vnc.
    expect(shouldAutoHandoffToVnc({ ...base, currentTransport: 'websocket' })).toBe(true);
  });

  it('supports a custom cooldownMs', () => {
    expect(shouldAutoHandoffToVnc({
      ...base,
      userJustSwitchedAt: 1_000_000 - 5_000,
      cooldownMs: 10_000,
    })).toBe(false);
    expect(shouldAutoHandoffToVnc({
      ...base,
      userJustSwitchedAt: 1_000_000 - 15_000,
      cooldownMs: 10_000,
    })).toBe(true);
  });
});

describe('shouldAutoHandoffToWebRTC', () => {
  const base = {
    remoteOs: 'macos',
    deviceId: 'dev-1',
    currentTransport: 'vnc' as const,
    userJustSwitchedAt: 0,
    previousMode: 'login_window' as const,
    currentMode: 'user_session' as const,
    now: 1_000_000,
  };

  it('returns true on transition login_window → user_session while on VNC', () => {
    expect(shouldAutoHandoffToWebRTC(base)).toBe(true);
  });

  it('returns true on transition from null (first poll) → user_session', () => {
    expect(shouldAutoHandoffToWebRTC({ ...base, previousMode: null })).toBe(true);
  });

  it('returns true on transition unavailable → user_session', () => {
    expect(shouldAutoHandoffToWebRTC({ ...base, previousMode: 'unavailable' })).toBe(true);
  });

  it('returns false when mode stays user_session (no transition)', () => {
    expect(shouldAutoHandoffToWebRTC({ ...base, previousMode: 'user_session' })).toBe(false);
  });

  it('returns false when currentMode is not user_session', () => {
    expect(shouldAutoHandoffToWebRTC({ ...base, currentMode: 'login_window' })).toBe(false);
    expect(shouldAutoHandoffToWebRTC({ ...base, currentMode: 'unavailable' })).toBe(false);
    expect(shouldAutoHandoffToWebRTC({ ...base, currentMode: null })).toBe(false);
  });

  it('returns false when remote is not macOS', () => {
    expect(shouldAutoHandoffToWebRTC({ ...base, remoteOs: 'windows' })).toBe(false);
    expect(shouldAutoHandoffToWebRTC({ ...base, remoteOs: null })).toBe(false);
  });

  it('returns false when deviceId is missing', () => {
    expect(shouldAutoHandoffToWebRTC({ ...base, deviceId: undefined })).toBe(false);
  });

  it('returns false when already on webrtc', () => {
    expect(shouldAutoHandoffToWebRTC({ ...base, currentTransport: 'webrtc' })).toBe(false);
  });

  it('returns false during user-choice cooldown (user just picked VNC)', () => {
    expect(shouldAutoHandoffToWebRTC({
      ...base,
      userJustSwitchedAt: 1_000_000 - 30_000,
    })).toBe(false);
  });

  it('returns true after the user-choice cooldown window expires', () => {
    expect(shouldAutoHandoffToWebRTC({
      ...base,
      userJustSwitchedAt: 1_000_000 - 60_001,
    })).toBe(true);
  });
});
