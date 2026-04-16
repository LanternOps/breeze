import { describe, it, expect } from 'vitest';
import type { TransportSession, TransportCapabilities } from './types';
import { capabilitiesFor } from './types';

describe('capabilitiesFor', () => {
  it('returns webrtc capabilities', () => {
    const c: TransportCapabilities = capabilitiesFor('webrtc');
    expect(c.monitors).toBe(true);
    expect(c.bitrateControl).toBe(true);
    expect(c.audio).toBe(true);
    expect(c.sas).toBe(true);
    expect(c.sessionSwitch).toBe(true);
    expect(c.clipboardChannel).toBe(true);
  });

  it('returns websocket capabilities', () => {
    const c = capabilitiesFor('websocket');
    expect(c.monitors).toBe(false);
    expect(c.bitrateControl).toBe(false);
    expect(c.audio).toBe(false);
    expect(c.sas).toBe(false);
    expect(c.sessionSwitch).toBe(false);
    expect(c.clipboardChannel).toBe(false);
  });

  it('returns vnc capabilities', () => {
    const c = capabilitiesFor('vnc');
    expect(c.monitors).toBe(false);
    expect(c.bitrateControl).toBe(false);
    expect(c.audio).toBe(false);
    expect(c.sas).toBe(false);
    expect(c.sessionSwitch).toBe(false);
    expect(c.clipboardChannel).toBe(true);
  });
});
