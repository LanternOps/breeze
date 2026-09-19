import { describe, expect, it } from 'vitest';
import { approvalMethodForRelease } from './approvalMethod';

/**
 * #5645 — the execution row's `approval_method` (spec §4.1) is DERIVED from the
 * releasing intent's decision record (§4.6), one case per method value.
 */
describe('approvalMethodForRelease', () => {
  it('a script_reviewer-decided intent is unattended_reviewer_gated, whatever its scope says', () => {
    expect(approvalMethodForRelease({ approvalScope: 'supervised', decidedVia: 'script_reviewer' }))
      .toBe('unattended_reviewer_gated');
    expect(approvalMethodForRelease({ approvalScope: 'four_eyes', decidedVia: 'script_reviewer' }))
      .toBe('unattended_reviewer_gated');
  });

  it('a supervised intent decided by a human is supervised_self', () => {
    expect(approvalMethodForRelease({ approvalScope: 'supervised', decidedVia: 'session_tap' })).toBe('supervised_self');
    expect(approvalMethodForRelease({ approvalScope: 'supervised', decidedVia: null })).toBe('supervised_self');
  });

  it('a four_eyes intent decided by a human is four_eyes', () => {
    expect(approvalMethodForRelease({ approvalScope: 'four_eyes', decidedVia: 'webauthn_platform' })).toBe('four_eyes');
    expect(approvalMethodForRelease({ approvalScope: 'four_eyes', decidedVia: null })).toBe('four_eyes');
  });
});
