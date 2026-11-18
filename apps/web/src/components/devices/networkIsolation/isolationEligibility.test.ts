import { describe, expect, it } from 'vitest';
import { ACTIVE_STATES, RESOLVED_TERMINAL_STATES, UNRESOLVED_TERMINAL_STATES } from '@breeze/shared';
import { startEligibility, releaseEligibility, START_REFUSAL_KEYS, isolationRefusalCopy } from './isolationEligibility';

describe('independent isolation eligibility', () => {
  it.each(['feature_disabled', 'partner_not_enabled', 'unsupported_platform', 'device_lifecycle', 'agent_below_gate', 'agent_not_ready', 'trust_restricted', 'isolation_already_active', 'isolation_unacknowledged', 'incident_mismatch', 'site_forbidden', 'device_offline', 'device_decommissioned', 'device_pending_assignment', 'backup_helper_update_required', 'relay_unavailable', 'invalid_allowlist'])('blocks start with copy for %s without blocking release', reason => {
    expect(startEligibility({ startEligibility: { allowed: false, reason } })).toEqual({ enabled: false, reason });
    expect(START_REFUSAL_KEYS[reason as keyof typeof START_REFUSAL_KEYS]).toBeTruthy();
    for (const state of ACTIVE_STATES) expect(releaseEligibility({ state })).toEqual({ visible: true, label: 'release' });
  });
  it('fails closed before eligibility loads and for unknown refusals', () => {
    expect(startEligibility(null).enabled).toBe(false);
    expect(startEligibility({ startEligibility: { allowed: false, reason: 'future_gate' } }).reason).toBe('unavailable');
    expect(startEligibility({ startEligibility: { allowed: true, reason: null } })).toEqual({ enabled: true });
  });
  it('does not release terminal episodes', () => {
    for (const state of [...RESOLVED_TERMINAL_STATES, ...UNRESOLVED_TERMINAL_STATES]) expect(releaseEligibility({ state }).visible).toBe(false);
  });
  it('maps only isolation refusal codes to refusal copy, leaving auth/validation errors to runAction', () => {
    const t = (key: string) => `t:${key}`;
    expect(isolationRefusalCopy('feature_disabled', t)).toBe('t:networkIsolation.refusal.feature_disabled');
    expect(isolationRefusalCopy('invalid_allowlist', t, { allowlistReason: 'server_url_missing' })).toBe('t:networkIsolation.refusal.invalid_allowlist_server_url_missing');
    expect(isolationRefusalCopy('invalid_allowlist', t, { allowlistReason: 'something_new' })).toBe('t:networkIsolation.refusal.invalid_allowlist');
    expect(isolationRefusalCopy('invalid_allowlist', t)).toBe('t:networkIsolation.refusal.invalid_allowlist');
    expect(isolationRefusalCopy('relay_unavailable', t, { allowlistReason: 'server_url_missing' })).toBe('t:networkIsolation.refusal.relay_unavailable');
    for (const code of ['MFA_REQUIRED', 'Access to this site denied', 'Device not found', 'VALIDATION_FAILED']) expect(isolationRefusalCopy(code, t)).toBeUndefined();
  });
});
