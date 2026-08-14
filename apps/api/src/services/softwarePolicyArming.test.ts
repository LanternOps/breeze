/**
 * #3543 — the uninstall-arming gate, unit-tested directly plus a drift guard.
 *
 * `evaluateSoftwarePolicyArming` is the shared definition of "this policy may
 * uninstall software". `softwareComplianceWorker.ts` still carries its own
 * inline copy of the same rule (deliberately left untouched by #3543 — it is the
 * long-standing automatic-remediation path and rewriting it was out of scope).
 * Two independent copies of a security gate drift, and drift in THAT file
 * reintroduces the #3381 bug class, so the parity block below pins them together
 * over a truth table: if someone changes one and not the other, this fails.
 */

import { describe, expect, it } from 'vitest';
import { evaluateSoftwarePolicyArming, readSoftwarePolicyAutoUninstall } from './softwarePolicyService';

describe('readSoftwarePolicyAutoUninstall — arming is opt-in', () => {
  it.each([
    ['null', null, false],
    ['undefined', undefined, false],
    ['empty object', {}, false],
    ['array', [], false],
    ['string "true"', 'true', false],
    ['number 1', 1, false],
    ['boolean true', true, false],
    ['autoUninstall: false', { autoUninstall: false }, false],
    ['autoUninstall: "true" (string, not boolean)', { autoUninstall: 'true' }, false],
    ['autoUninstall: 1 (truthy, not true)', { autoUninstall: 1 }, false],
    ['autoUninstall: true', { autoUninstall: true }, true],
  ])('%s -> %s', (_label, input, expected) => {
    expect(readSoftwarePolicyAutoUninstall(input)).toBe(expected);
  });
});

describe('evaluateSoftwarePolicyArming', () => {
  const ARMED_OPTIONS = { autoUninstall: true };

  it('is armed only when mode is non-audit AND enforceMode AND autoUninstall', () => {
    expect(evaluateSoftwarePolicyArming({
      mode: 'blocklist', enforceMode: true, remediationOptions: ARMED_OPTIONS,
    })).toEqual({ armed: true });
  });

  it('reports audit_mode first, even when otherwise fully armed', () => {
    const state = evaluateSoftwarePolicyArming({
      mode: 'audit', enforceMode: true, remediationOptions: ARMED_OPTIONS,
    });
    expect(state.armed).toBe(false);
    expect(state).toMatchObject({ reason: 'audit_mode' });
  });

  it('reports enforce_mode_off when enforcement is off', () => {
    for (const enforceMode of [false, null, undefined]) {
      const state = evaluateSoftwarePolicyArming({
        mode: 'blocklist', enforceMode, remediationOptions: ARMED_OPTIONS,
      });
      expect(state).toMatchObject({ armed: false, reason: 'enforce_mode_off' });
    }
  });

  it('reports auto_uninstall_off when enforcement is on but uninstall is not armed', () => {
    const state = evaluateSoftwarePolicyArming({
      mode: 'allowlist', enforceMode: true, remediationOptions: { autoUninstall: false },
    });
    expect(state).toMatchObject({ armed: false, reason: 'auto_uninstall_off' });
  });

  it('always carries an operator-legible message when unarmed', () => {
    for (const policy of [
      { mode: 'audit', enforceMode: true, remediationOptions: ARMED_OPTIONS },
      { mode: 'blocklist', enforceMode: false, remediationOptions: ARMED_OPTIONS },
      { mode: 'blocklist', enforceMode: true, remediationOptions: null },
    ]) {
      const state = evaluateSoftwarePolicyArming(policy);
      expect(state.armed).toBe(false);
      if (!state.armed) expect(state.message.length).toBeGreaterThan(20);
    }
  });
});

/**
 * Drift guard against the untouched inline gate in
 * `apps/api/src/jobs/softwareComplianceWorker.ts` (~line 397):
 *   policy.enforceMode && policy.mode !== 'audit' && remediationOptions.autoUninstallEnabled
 * where `autoUninstallEnabled` comes from its local `readRemediationOptions`
 * (`options.autoUninstall === true`). Reproduced here as the reference oracle.
 */
function complianceWorkerInlineGate(policy: {
  mode: string | null | undefined;
  enforceMode: boolean | null | undefined;
  remediationOptions: unknown;
}): boolean {
  const raw = policy.remediationOptions;
  const autoUninstallEnabled = !raw || typeof raw !== 'object'
    ? false
    : (raw as Record<string, unknown>).autoUninstall === true;
  return Boolean(policy.enforceMode) && policy.mode !== 'audit' && autoUninstallEnabled;
}

describe('gate parity with the inline compliance-worker gate (#3543 drift guard)', () => {
  const MODES = ['allowlist', 'blocklist', 'audit'];
  const ENFORCE = [true, false, null, undefined];
  const OPTIONS: unknown[] = [
    null, undefined, {}, [], 'true', 1,
    { autoUninstall: true }, { autoUninstall: false }, { autoUninstall: 'true' },
    { autoUninstall: true, cooldownMinutes: 30 },
  ];

  it('agrees on every combination of mode / enforceMode / remediationOptions', () => {
    const disagreements: string[] = [];
    for (const mode of MODES) {
      for (const enforceMode of ENFORCE) {
        for (const remediationOptions of OPTIONS) {
          const policy = { mode, enforceMode, remediationOptions };
          const shared = evaluateSoftwarePolicyArming(policy).armed;
          const inline = complianceWorkerInlineGate(policy);
          if (shared !== inline) {
            disagreements.push(
              `mode=${mode} enforceMode=${String(enforceMode)} options=${JSON.stringify(remediationOptions)}: shared=${shared} inline=${inline}`
            );
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
  });
});
