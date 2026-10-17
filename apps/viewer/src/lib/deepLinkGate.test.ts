import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeepLinkGate, deepLinkKey } from './deepLinkGate';
import type { ConnectionParams } from './protocol';

const DESKTOP: ConnectionParams = {
  mode: 'desktop',
  sessionId: 'sess-1',
  connectCode: 'code-1',
  apiUrl: 'https://api.example.test',
};

const VNC: ConnectionParams = {
  mode: 'vnc',
  tunnelId: 'tun-1',
  deviceId: 'dev-1',
  code: 'code-1',
  apiUrl: 'https://api.example.test',
};

describe('deepLinkKey', () => {
  it('keys a desktop link on session, connect code and API', () => {
    expect(deepLinkKey(DESKTOP)).toBe('sess-1|code-1|https://api.example.test');
  });

  it('keys a VNC link on tunnel, code and API', () => {
    expect(deepLinkKey(VNC)).toBe('tun-1|code-1|https://api.example.test');
  });

  it('distinguishes links that differ only in their connect code', () => {
    expect(deepLinkKey(DESKTOP)).not.toBe(deepLinkKey({ ...DESKTOP, connectCode: 'code-2' }));
  });
});

describe('createDeepLinkGate (#8947)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies the first delivery of a link', () => {
    const gate = createDeepLinkGate();
    expect(gate.admit(deepLinkKey(DESKTOP))).toBe(true);
  });

  it('drops an immediate re-delivery of the current link', () => {
    const gate = createDeepLinkGate();
    gate.admit(deepLinkKey(DESKTOP));
    expect(gate.admit(deepLinkKey(DESKTOP))).toBe(false);
  });

  // The regression: the Rust shell re-emits the same URL at +0.5 s and +2.0 s
  // and the poll path delivers it too. A webview stalled for more than 2 s used
  // to see the re-delivery as new, re-run the connect effect mid-flight and
  // post a second offer for the same session.
  it('drops a re-delivery of the current link however late it arrives', () => {
    const gate = createDeepLinkGate();
    gate.admit(deepLinkKey(DESKTOP));
    vi.advanceTimersByTime(6_400);
    expect(gate.admit(deepLinkKey(DESKTOP))).toBe(false);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(gate.admit(deepLinkKey(DESKTOP))).toBe(false);
  });

  it('applies the same link again once the viewer errored or disconnected', () => {
    const gate = createDeepLinkGate();
    gate.admit(deepLinkKey(DESKTOP));
    gate.release();
    expect(gate.admit(deepLinkKey(DESKTOP))).toBe(true);
    // ...and that re-application is itself the current link again.
    expect(gate.admit(deepLinkKey(DESKTOP))).toBe(false);
  });

  it('applies a different link while one is current', () => {
    const gate = createDeepLinkGate();
    gate.admit(deepLinkKey(DESKTOP));
    const next = deepLinkKey({ ...DESKTOP, connectCode: 'code-2' });
    expect(gate.admit(next)).toBe(true);
    expect(gate.admit(next)).toBe(false);
  });
});
