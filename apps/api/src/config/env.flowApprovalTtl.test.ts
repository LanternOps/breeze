import { afterEach, describe, expect, it } from 'vitest';
import { flowApprovalTtlHours } from './env';

/** Tool catalog W04 (#5219): how long a parked Tier-3 flow step waits for a human. */
describe('FLOW_APPROVAL_TTL_HOURS', () => {
  const original = process.env.FLOW_APPROVAL_TTL_HOURS;
  afterEach(() => {
    if (original === undefined) delete process.env.FLOW_APPROVAL_TTL_HOURS;
    else process.env.FLOW_APPROVAL_TTL_HOURS = original;
  });

  it('defaults to 24 hours when unset', () => {
    delete process.env.FLOW_APPROVAL_TTL_HOURS;
    expect(flowApprovalTtlHours()).toBe(24);
  });

  it.each([
    ['', 24], ['abc', 24], ['0', 24], ['-3', 24], ['2.5', 24],
    ['1', 1], ['48', 48], ['168', 168], ['500', 168],
  ])('FLOW_APPROVAL_TTL_HOURS=%s → %s (garbage falls back, out-of-range clamps to 1..168)', (raw, expected) => {
    process.env.FLOW_APPROVAL_TTL_HOURS = raw as string;
    expect(flowApprovalTtlHours()).toBe(expected);
  });

  it('is read at call time', () => {
    process.env.FLOW_APPROVAL_TTL_HOURS = '2';
    expect(flowApprovalTtlHours()).toBe(2);
    process.env.FLOW_APPROVAL_TTL_HOURS = '3';
    expect(flowApprovalTtlHours()).toBe(3);
  });
});
