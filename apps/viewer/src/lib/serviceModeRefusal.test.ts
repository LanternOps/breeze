import { describe, it, expect } from 'vitest';
import { isServiceModeRefusal, serviceModeRefusalMessage } from './serviceModeRefusal';
// apps/viewer has no React harness (see DesktopViewer.capsLock.test.ts), so the
// wiring is guarded over the source text.
import source from '../components/DesktopViewer.tsx?raw';

describe('DesktopViewer wiring', () => {
  it('maps the WebSocket transport error through the service-mode refusal helpers', () => {
    expect(source).toMatch(
      /const message = isServiceModeRefusal\(rawMessage\)\s*\?\s*serviceModeRefusalMessage\(webrtcUsableRef\.current\)\s*:\s*rawMessage;/,
    );
    // The mapped text, not the raw agent text, must reach the UI and the host.
    expect(source).toContain('setErrorMessage(message);\n        onError(message);');
    expect(source).not.toContain('setErrorMessage(rawMessage)');
  });
});

// The API wraps the agent's refusal as
// "The remote device could not start the desktop stream: <agent error>", and the
// agent's text comes from serviceUnavailable() in
// agent/internal/heartbeat/handlers_desktop.go.
const RELAYED =
  'The remote device could not start the desktop stream: ' +
  'desktop_stream_start unavailable in headless/service mode; use WebRTC instead';

describe('isServiceModeRefusal', () => {
  it('matches the relayed agent refusal', () => {
    expect(isServiceModeRefusal(RELAYED)).toBe(true);
  });
  it('matches the bare agent text', () => {
    expect(isServiceModeRefusal('start_desktop unavailable in headless/service mode; use WebRTC instead')).toBe(true);
  });
  it('ignores unrelated errors', () => {
    expect(isServiceModeRefusal('WebSocket connection error')).toBe(false);
    expect(isServiceModeRefusal('')).toBe(false);
    expect(isServiceModeRefusal(null)).toBe(false);
    expect(isServiceModeRefusal(undefined)).toBe(false);
    expect(isServiceModeRefusal('unavailable in headless mode')).toBe(false);
  });
});

describe('serviceModeRefusalMessage', () => {
  it('explains the missing WebRTC and what to do when this viewer has none', () => {
    const msg = serviceModeRefusalMessage(false);
    expect(msg).toMatch(/needs WebRTC/i);
    expect(msg).toMatch(/does not support WebRTC/i);
  });
  it('does not blame the viewer when WebRTC is available', () => {
    expect(serviceModeRefusalMessage(true)).not.toMatch(/does not support WebRTC/i);
  });
});
