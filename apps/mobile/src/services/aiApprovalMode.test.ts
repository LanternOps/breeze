import { describe, expect, it } from 'vitest';

import { approvalModeCopy, approvalModeFromUsage, parseApprovalMode } from './aiApprovalMode';

describe('parseApprovalMode', () => {
  it('accepts the four server modes', () => {
    for (const mode of ['per_step', 'action_plan', 'auto_approve', 'hybrid_plan']) {
      expect(parseApprovalMode(mode)).toBe(mode);
    }
  });

  it('rejects anything else rather than guessing a posture', () => {
    expect(parseApprovalMode('manual')).toBeNull();
    expect(parseApprovalMode('')).toBeNull();
    expect(parseApprovalMode(undefined)).toBeNull();
    expect(parseApprovalMode(3)).toBeNull();
  });
});

describe('approvalModeFromUsage', () => {
  it('reads budget.approvalMode off GET /ai/usage', () => {
    expect(approvalModeFromUsage({ budget: { approvalMode: 'action_plan' } })).toBe('action_plan');
  });

  it('is null when the caller has no org budget (partner/system login without an org)', () => {
    expect(approvalModeFromUsage({ budget: null })).toBeNull();
    expect(approvalModeFromUsage({})).toBeNull();
    expect(approvalModeFromUsage(null)).toBeNull();
    expect(approvalModeFromUsage({ budget: { approvalMode: 'bogus' } })).toBeNull();
  });
});

describe('approvalModeCopy', () => {
  it('per_step names the setting home, so the user knows where the fix lives', () => {
    const copy = approvalModeCopy('per_step');
    expect(copy.label).toBe('Approve each step');
    expect(copy.description).toMatch(/Organization settings/);
    expect(copy.description).toMatch(/AI tab/);
    expect(copy.description).not.toMatch(/AI Usage/);
  });

  it('plan modes say destructive actions still ask separately', () => {
    expect(approvalModeCopy('action_plan').label).toBe('Approve the plan');
    expect(approvalModeCopy('action_plan').description).toMatch(/destructive/i);
    expect(approvalModeCopy('hybrid_plan').label).toBe('Approve the plan, with Stop');
    expect(approvalModeCopy('hybrid_plan').description).toMatch(/stop/i);
  });

  it('auto_approve says what still asks', () => {
    expect(approvalModeCopy('auto_approve').label).toBe('Auto-approve');
    expect(approvalModeCopy('auto_approve').description).toMatch(/destructive/i);
  });

  it('unknown mode falls back to a neutral explanation', () => {
    const copy = approvalModeCopy(null);
    expect(copy.label).toBe('Set by your organization');
    expect(copy.description).toMatch(/Organization settings/);
    expect(copy.description).not.toMatch(/AI Usage/);
  });
});
