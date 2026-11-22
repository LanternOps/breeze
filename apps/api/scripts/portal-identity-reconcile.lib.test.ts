import { describe, expect, it } from 'vitest';
import { ReconcileUsageError, parseReconcileArgs, reconcileExitCode } from './portal-identity-reconcile.lib';

const ORG = '33333333-3333-4333-8333-333333333333';
const clean = { missingIdentity: 0, orphanIdentity: 0, mismatched: 0, halfPopulated: 0 };

describe('portal-identity-reconcile CLI', () => {
  it('parses no arguments as a fleet-wide run', () => {
    expect(parseReconcileArgs([])).toEqual({ orgId: undefined });
  });

  it('parses --org <uuid>', () => {
    expect(parseReconcileArgs(['--org', ORG])).toEqual({ orgId: ORG });
  });

  it('refuses a non-uuid --org, a missing value and unknown flags', () => {
    expect(() => parseReconcileArgs(['--org', 'acme'])).toThrow(ReconcileUsageError);
    expect(() => parseReconcileArgs(['--org'])).toThrow(ReconcileUsageError);
    expect(() => parseReconcileArgs(['--repair'])).toThrow(ReconcileUsageError);
  });

  it('exits 0 when clean and 1 when any bucket has drift', () => {
    expect(reconcileExitCode({ counts: clean })).toBe(0);
    expect(reconcileExitCode({ counts: { ...clean, halfPopulated: 1 } })).toBe(1);
    expect(reconcileExitCode({ counts: { ...clean, missingIdentity: 3 } })).toBe(1);
  });
});
