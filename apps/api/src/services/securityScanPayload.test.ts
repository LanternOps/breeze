import { describe, expect, it } from 'vitest';
import { SECURITY_SCAN_SETTINGS_DEFAULTS } from '@breeze/shared';
import { buildSecurityScanPayload } from './securityScanPayload';
import { SECURITY_SCAN_TIMEOUT_CEILING_MINUTES } from './securityScanSweepConfig';

/**
 * #10057 — every security_scan payload carries a deadline. With no policy the
 * agent used to scan with NO deadline (`Timeout == 0`), while the orphan
 * finalizer releases the device's slot at the 720-minute ceiling: a new scan
 * could then start while the old one was still running. Agents since #6263 W01
 * honour `timeoutMinutes`, so putting the ceiling on the wire bounds every
 * deployed agent without waiting for the agent-side default.
 */
describe('buildSecurityScanPayload deadline (#10057)', () => {
  it('sends the 720-minute ceiling when no policy governs the device', () => {
    const payload = buildSecurityScanPayload('scan-1', 'quick', null);
    expect(payload.timeoutMinutes).toBe(SECURITY_SCAN_TIMEOUT_CEILING_MINUTES);
    expect(SECURITY_SCAN_TIMEOUT_CEILING_MINUTES).toBe(720);
  });

  it('sends the ceiling on a detect-only sweep payload with no policy', () => {
    const payload = buildSecurityScanPayload('scan-1', 'quick', null, undefined, [], { detectOnly: true });
    expect(payload).toMatchObject({ timeoutMinutes: 720, autoQuarantine: false });
  });

  it("keeps the policy's own budget when one governs the device", () => {
    const payload = buildSecurityScanPayload('scan-1', 'full', { ...SECURITY_SCAN_SETTINGS_DEFAULTS, scanTimeoutMinutes: 90 });
    expect(payload.timeoutMinutes).toBe(90);
  });

  it('still sends no other policy keys when no policy governs the device', () => {
    const payload = buildSecurityScanPayload('scan-1', 'quick', null);
    expect(Object.keys(payload).sort()).toEqual(['scanRecordId', 'scanType', 'timeoutMinutes', 'triggerDefender']);
  });
});
