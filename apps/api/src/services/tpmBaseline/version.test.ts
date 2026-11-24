import { describe, expect, it } from 'vitest';
import { TPM_BASELINE_VERSION_PATTERN, tpmBaselineVersion, tpmBaselineVersionMatches } from './version';

const state = { deviceId: '00000000-0000-4000-8000-000000000001', baselineSha256: 'a'.repeat(64), mismatchSha256: 'b'.repeat(64) };

describe('tpmBaselineVersion (#8318 wave T2)', () => {
  it('is an opaque 43-character token that matches only its own state', () => {
    const version = tpmBaselineVersion(state);
    expect(version).toMatch(TPM_BASELINE_VERSION_PATTERN);
    expect(version).not.toContain(state.baselineSha256.slice(0, 8));
    expect(tpmBaselineVersionMatches(version, state)).toBe(true);
    expect(tpmBaselineVersionMatches(version, { ...state, deviceId: state.deviceId.toUpperCase() })).toBe(true);
    expect(tpmBaselineVersionMatches(version, { ...state, mismatchSha256: 'c'.repeat(64) })).toBe(false);
    expect(tpmBaselineVersionMatches(version, { ...state, baselineSha256: 'c'.repeat(64) })).toBe(false);
    expect(tpmBaselineVersionMatches(version, { ...state, deviceId: '00000000-0000-4000-8000-000000000002' })).toBe(false);
  });

  it('refuses malformed input', () => {
    expect(tpmBaselineVersionMatches('', state)).toBe(false);
    expect(tpmBaselineVersionMatches('x'.repeat(44), state)).toBe(false);
    expect(tpmBaselineVersionMatches('!'.repeat(43), state)).toBe(false);
  });
});
