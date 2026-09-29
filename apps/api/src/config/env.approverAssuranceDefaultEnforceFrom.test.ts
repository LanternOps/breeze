import { afterEach, describe, expect, it } from 'vitest';
import {
  APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM,
  approverAssuranceDefaultEnforceFrom,
} from './env';

// The platform-wide date from which a partner that never chose an
// approval-security setting is treated as enforcing for high/critical
// approvals. Read at CALL time so a self-hoster's override (and a test) takes
// effect without a module reload.
describe('approverAssuranceDefaultEnforceFrom()', () => {
  const original = process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM;
  afterEach(() => {
    if (original === undefined) delete process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM;
    else process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM = original;
  });

  it('defaults to 2026-11-05T00:00:00Z', () => {
    delete process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM;
    expect(APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM).toBe('2026-11-05T00:00:00.000Z');
    expect(approverAssuranceDefaultEnforceFrom().toISOString()).toBe('2026-11-05T00:00:00.000Z');
  });

  it('treats an empty value as unset', () => {
    process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM = '  ';
    expect(approverAssuranceDefaultEnforceFrom().toISOString()).toBe('2026-11-05T00:00:00.000Z');
  });

  it('honours an ISO date override', () => {
    process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM = '2027-01-15';
    expect(approverAssuranceDefaultEnforceFrom().toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });

  it('honours an ISO timestamp override', () => {
    process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM = '2026-12-01T09:30:00Z';
    expect(approverAssuranceDefaultEnforceFrom().toISOString()).toBe('2026-12-01T09:30:00.000Z');
  });

  it('falls back to the built-in date for an unparseable value (boot validation rejects it first)', () => {
    process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM = 'next tuesday';
    expect(approverAssuranceDefaultEnforceFrom().toISOString()).toBe('2026-11-05T00:00:00.000Z');
  });

  it('returns a fresh Date each call (callers cannot mutate the constant)', () => {
    delete process.env.APPROVER_ASSURANCE_DEFAULT_ENFORCE_FROM;
    const a = approverAssuranceDefaultEnforceFrom();
    a.setUTCFullYear(2099);
    expect(approverAssuranceDefaultEnforceFrom().toISOString()).toBe('2026-11-05T00:00:00.000Z');
  });
});
