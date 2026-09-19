/**
 * #3543 — the arming gate, unit-tested directly plus a drift guard.
 * #5505 W01 — the gate is now verb-aware: `evaluateSoftwarePolicyArming(policy,
 * verb)` answers "may this policy UNINSTALL?" or "may this policy INSTALL?"
 * against two independent flags. The second parameter is REQUIRED so the
 * compiler finds every caller; there is no default verb.
 *
 * `softwareComplianceWorker.ts` still carries its own inline copy of the
 * uninstall rule (W02 removes it, contract D11). Two independent copies of a
 * security gate drift, and drift in THAT file reintroduces the #3381 bug class,
 * so the parity block below pins them together over a truth table.
 */

import { describe, expect, it } from 'vitest';
import {
  evaluateSoftwarePolicyArming,
  readSoftwarePolicyAutoInstall,
  readSoftwarePolicyAutoUninstall,
} from './softwarePolicyService';

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

describe('readSoftwarePolicyAutoInstall — arming is opt-in', () => {
  it.each([
    ['null', null, false],
    ['undefined', undefined, false],
    ['empty object', {}, false],
    ['array', [], false],
    ['string "true"', 'true', false],
    ['number 1', 1, false],
    ['boolean true', true, false],
    ['autoInstall: false', { autoInstall: false }, false],
    ['autoInstall: "true" (string, not boolean)', { autoInstall: 'true' }, false],
    ['autoInstall: 1 (truthy, not true)', { autoInstall: 1 }, false],
    ['autoInstall: true', { autoInstall: true }, true],
  ])('%s -> %s', (_label, input, expected) => {
    expect(readSoftwarePolicyAutoInstall(input)).toBe(expected);
  });

  it('does not read autoUninstall', () => {
    expect(readSoftwarePolicyAutoInstall({ autoUninstall: true })).toBe(false);
    expect(readSoftwarePolicyAutoUninstall({ autoInstall: true })).toBe(false);
  });
});

describe('evaluateSoftwarePolicyArming — uninstall verb', () => {
  const ARMED_OPTIONS = { autoUninstall: true };

  it('is armed only when mode is non-audit AND enforceMode AND autoUninstall', () => {
    expect(evaluateSoftwarePolicyArming({
      mode: 'blocklist', enforceMode: true, remediationOptions: ARMED_OPTIONS,
    }, 'uninstall')).toEqual({ armed: true });
  });

  it('reports audit_mode first, even when otherwise fully armed', () => {
    const state = evaluateSoftwarePolicyArming({
      mode: 'audit', enforceMode: true, remediationOptions: ARMED_OPTIONS,
    }, 'uninstall');
    expect(state.armed).toBe(false);
    expect(state).toMatchObject({ reason: 'audit_mode' });
  });

  it('reports enforce_mode_off when enforcement is off', () => {
    for (const enforceMode of [false, null, undefined]) {
      const state = evaluateSoftwarePolicyArming({
        mode: 'blocklist', enforceMode, remediationOptions: ARMED_OPTIONS,
      }, 'uninstall');
      expect(state).toMatchObject({ armed: false, reason: 'enforce_mode_off' });
    }
  });

  it('reports auto_uninstall_off when enforcement is on but uninstall is not armed', () => {
    const state = evaluateSoftwarePolicyArming({
      mode: 'allowlist', enforceMode: true, remediationOptions: { autoUninstall: false },
    }, 'uninstall');
    expect(state).toMatchObject({ armed: false, reason: 'auto_uninstall_off' });
  });

  it('always carries an operator-legible message when unarmed', () => {
    for (const policy of [
      { mode: 'audit', enforceMode: true, remediationOptions: ARMED_OPTIONS },
      { mode: 'blocklist', enforceMode: false, remediationOptions: ARMED_OPTIONS },
      { mode: 'blocklist', enforceMode: true, remediationOptions: null },
    ]) {
      const state = evaluateSoftwarePolicyArming(policy, 'uninstall');
      expect(state.armed).toBe(false);
      if (!state.armed) expect(state.message.length).toBeGreaterThan(20);
    }
  });
});

describe('evaluateSoftwarePolicyArming — install verb', () => {
  const ARMED_OPTIONS = { autoInstall: true };

  it('is armed only when mode is non-audit AND enforceMode AND autoInstall', () => {
    expect(evaluateSoftwarePolicyArming({
      mode: 'allowlist', enforceMode: true, remediationOptions: ARMED_OPTIONS,
    }, 'install')).toEqual({ armed: true });
  });

  it('reports audit_mode first, even when otherwise fully armed', () => {
    const state = evaluateSoftwarePolicyArming({
      mode: 'audit', enforceMode: true, remediationOptions: ARMED_OPTIONS,
    }, 'install');
    expect(state).toMatchObject({ armed: false, reason: 'audit_mode' });
  });

  it('reports enforce_mode_off when enforcement is off', () => {
    for (const enforceMode of [false, null, undefined]) {
      const state = evaluateSoftwarePolicyArming({
        mode: 'allowlist', enforceMode, remediationOptions: ARMED_OPTIONS,
      }, 'install');
      expect(state).toMatchObject({ armed: false, reason: 'enforce_mode_off' });
    }
  });

  it('reports auto_install_off — never auto_uninstall_off — when install is not armed', () => {
    const state = evaluateSoftwarePolicyArming({
      mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: false },
    }, 'install');
    expect(state).toMatchObject({ armed: false, reason: 'auto_install_off' });
    if (!state.armed) expect(state.message).toContain('remediationOptions.autoInstall');
  });
});

describe('the two verbs are independent (spec: "arming install does not arm uninstall")', () => {
  const BASE = { mode: 'allowlist' as const, enforceMode: true };

  it('autoUninstall alone arms uninstall and NOT install', () => {
    const policy = { ...BASE, remediationOptions: { autoUninstall: true } };
    expect(evaluateSoftwarePolicyArming(policy, 'uninstall').armed).toBe(true);
    expect(evaluateSoftwarePolicyArming(policy, 'install')).toMatchObject({ armed: false, reason: 'auto_install_off' });
  });

  it('autoInstall alone arms install and NOT uninstall', () => {
    const policy = { ...BASE, remediationOptions: { autoInstall: true } };
    expect(evaluateSoftwarePolicyArming(policy, 'install').armed).toBe(true);
    expect(evaluateSoftwarePolicyArming(policy, 'uninstall')).toMatchObject({ armed: false, reason: 'auto_uninstall_off' });
  });

  it('both flags arm both verbs', () => {
    const policy = { ...BASE, remediationOptions: { autoInstall: true, autoUninstall: true } };
    expect(evaluateSoftwarePolicyArming(policy, 'install').armed).toBe(true);
    expect(evaluateSoftwarePolicyArming(policy, 'uninstall').armed).toBe(true);
  });
});

/**
 * The uninstall messages are user-visible: `aiToolsCompliance.ts` returns
 * `arming.message` straight to the model and the route surfaces it to a
 * technician. Making the gate verb-aware must not reword the uninstall copy,
 * so pin all three byte-for-byte.
 */
describe('uninstall refusal messages are unchanged byte-for-byte', () => {
  it.each([
    [
      { mode: 'audit', enforceMode: true, remediationOptions: { autoUninstall: true } },
      'Policy is audit-only (mode="audit"); it cannot uninstall software.',
    ],
    [
      { mode: 'blocklist', enforceMode: false, remediationOptions: { autoUninstall: true } },
      'Policy enforcement is off (enforceMode=false), so it is detect-only and must not uninstall software. '
      + 'An administrator has to enable enforcement on the policy first.',
    ],
    [
      { mode: 'blocklist', enforceMode: true, remediationOptions: null },
      'Policy remediation is not armed (remediationOptions.autoUninstall is not true), so it must not uninstall software. '
      + 'An administrator has to enable automatic uninstall on the policy first.',
    ],
  ])('%#', (policy, expected) => {
    const state = evaluateSoftwarePolicyArming(policy, 'uninstall');
    expect(state.armed).toBe(false);
    if (!state.armed) expect(state.message).toBe(expected);
  });
});

describe('install refusal messages name the install verb', () => {
  it('audit_mode says "install", not "uninstall"', () => {
    const state = evaluateSoftwarePolicyArming(
      { mode: 'audit', enforceMode: true, remediationOptions: { autoInstall: true } },
      'install'
    );
    expect(state.armed).toBe(false);
    if (!state.armed) {
      expect(state.message).toBe('Policy is audit-only (mode="audit"); it cannot install software.');
    }
  });

  it('enforce_mode_off says "install", not "uninstall"', () => {
    const state = evaluateSoftwarePolicyArming(
      { mode: 'allowlist', enforceMode: false, remediationOptions: { autoInstall: true } },
      'install'
    );
    expect(state.armed).toBe(false);
    if (!state.armed) {
      expect(state.message).toBe(
        'Policy enforcement is off (enforceMode=false), so it is detect-only and must not install software. '
        + 'An administrator has to enable enforcement on the policy first.'
      );
    }
  });

  it('auto_install_off names the autoInstall option', () => {
    const state = evaluateSoftwarePolicyArming(
      { mode: 'allowlist', enforceMode: true, remediationOptions: {} },
      'install'
    );
    expect(state.armed).toBe(false);
    if (!state.armed) {
      expect(state.message).toBe(
        'Policy remediation is not armed (remediationOptions.autoInstall is not true), so it must not install software. '
        + 'An administrator has to enable automatic install on the policy first.'
      );
    }
  });
});

/**
 * Drift guard against the untouched inline gate in
 * `apps/api/src/jobs/softwareComplianceWorker.ts:423-427`:
 *   policy.enforceMode && policy.mode !== 'audit' && remediationOptions.autoUninstallEnabled
 * where `autoUninstallEnabled` comes from its local `readRemediationOptions`
 * (`:158`, `options.autoUninstall === true`). Reproduced here as the reference
 * oracle. W02 deletes that inline copy (contract D11); until then this holds.
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
    { autoInstall: true }, { autoInstall: true, autoUninstall: true },
  ];

  it('agrees on every combination of mode / enforceMode / remediationOptions', () => {
    const disagreements: string[] = [];
    for (const mode of MODES) {
      for (const enforceMode of ENFORCE) {
        for (const remediationOptions of OPTIONS) {
          const policy = { mode, enforceMode, remediationOptions };
          const shared = evaluateSoftwarePolicyArming(policy, 'uninstall').armed;
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
