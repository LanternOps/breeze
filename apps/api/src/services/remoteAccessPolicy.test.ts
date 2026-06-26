import { describe, it, expect } from 'vitest';
import { getRemoteAccessBaseline } from './policyBaselineDefaults';

// Guards the security-sensitive default: Remote Desktop / VNC / Remote Tools
// must stay ON-by-default after sourcing DEFAULTS from the canonical module.
describe('remote access baseline defaults (single source of truth)', () => {
  it('keeps the permissive remote capabilities ON by default', () => {
    const d = getRemoteAccessBaseline();
    expect(d.webrtcDesktop).toBe(true);
    expect(d.vncRelay).toBe(true);
    expect(d.remoteTools).toBe(true);
    expect(d.enableProxy).toBe(true);
    expect(d.autoEnableProxy).toBe(false);
    expect(d.maxConcurrentTunnels).toBe(5);
    expect(d.idleTimeoutMinutes).toBe(5);
    expect(d.maxSessionDurationHours).toBe(8);
    expect(d.clipboardViewerToHost).toBe(true);
  });
});
