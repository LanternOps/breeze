import { describe, expect, it } from 'vitest';
import {
  AI_APPROVAL_TIMEOUT_DEFAULT_MINUTES,
  AI_APPROVAL_TIMEOUT_MAX_MINUTES,
  AI_APPROVAL_TIMEOUT_MIN_MINUTES,
  aiApprovalSettingsSchema,
  resolveAiApprovalTimeout,
} from './aiApprovalSettings';

const partner = (minutes: unknown) => ({ aiApprovals: { interactiveTimeoutMinutes: minutes } });
const org = partner;

describe('aiApprovalSettingsSchema', () => {
  it('accepts the 5-60 minute range and an empty block', () => {
    expect(aiApprovalSettingsSchema.safeParse({}).success).toBe(true);
    expect(aiApprovalSettingsSchema.safeParse({ interactiveTimeoutMinutes: 5 }).success).toBe(true);
    expect(aiApprovalSettingsSchema.safeParse({ interactiveTimeoutMinutes: 60 }).success).toBe(true);
  });

  it.each([4, 61, 1440, 7.5, '15', null])('rejects %s', (value) => {
    expect(aiApprovalSettingsSchema.safeParse({ interactiveTimeoutMinutes: value }).success).toBe(false);
  });

  it('rejects unknown keys instead of storing a typo silently', () => {
    expect(aiApprovalSettingsSchema.safeParse({ interactiveTimeoutMins: 30 }).success).toBe(false);
  });
});

describe('resolveAiApprovalTimeout', () => {
  it('pins the documented range and default', () => {
    expect([AI_APPROVAL_TIMEOUT_MIN_MINUTES, AI_APPROVAL_TIMEOUT_DEFAULT_MINUTES, AI_APPROVAL_TIMEOUT_MAX_MINUTES])
      .toEqual([5, 5, 60]);
  });

  it('falls back to the product default when nothing is set', () => {
    expect(resolveAiApprovalTimeout({}, {})).toEqual({
      minutes: 5,
      source: 'default',
      inheritedMinutes: 5,
      inheritedSource: 'default',
    });
    expect(resolveAiApprovalTimeout(null, undefined).minutes).toBe(5);
  });

  it('uses the partner default when the org has no override', () => {
    expect(resolveAiApprovalTimeout(partner(30), {})).toEqual({
      minutes: 30,
      source: 'partner',
      inheritedMinutes: 30,
      inheritedSource: 'partner',
    });
  });

  it('lets the org override WIN over the partner default, in both directions', () => {
    expect(resolveAiApprovalTimeout(partner(30), org(10))).toEqual({
      minutes: 10,
      source: 'org',
      inheritedMinutes: 30,
      inheritedSource: 'partner',
    });
    expect(resolveAiApprovalTimeout(partner(10), org(45)).minutes).toBe(45);
  });

  it('ignores an out-of-range or malformed stored value and falls through to the next level', () => {
    // Stored via a wholesale system-scope settings write that skips the schema.
    expect(resolveAiApprovalTimeout(partner(30), org(1440))).toMatchObject({ minutes: 30, source: 'partner' });
    expect(resolveAiApprovalTimeout(partner('45'), org(null))).toMatchObject({ minutes: 5, source: 'default' });
    expect(resolveAiApprovalTimeout({ aiApprovals: 'x' }, { aiApprovals: [] })).toMatchObject({ source: 'default' });
  });
});
