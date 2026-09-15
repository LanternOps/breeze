/**
 * #4442 W04 Task 5 — the CREATION-time act gate.
 *
 * `resolvePolicyDecisionState`'s blanket `if (args.hasScope) return
 * 'human_required'` (P2-2) becomes a narrow five-condition allowance. Every
 * condition here fails CLOSED, like every other branch of that ladder: an
 * unresolved input is `human_required`, never "probably fine".
 *
 * The allowance keys on `trigger_kind === 'sweep_finding'`, NOT on "the intent
 * has a scope" — that is load-bearing. A ticket scope (P2-4) and any scope
 * kind added later must not inherit unattended execution by the accident of
 * having a scope at all.
 *
 * Freshness and the live condition re-probe are DECIDE-time gates
 * (`policyDecide.ts`); creation runs inside the intent's own transaction and
 * cannot probe.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  __resolvePolicyDecisionStateForTest as resolve,
  type SweepActEligibility,
} from './intentService';
import { subjectMatchesArguments } from './intentTargetScope';

type Args = Parameters<typeof resolve>[0];

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_DEVICE_ID = '22222222-2222-4222-8222-222222222222';

function sweepAct(overrides: Partial<SweepActEligibility> = {}): SweepActEligibility {
  return {
    scheduleActMode: true,
    subject: { kind: 'service_down', key: 'Spooler', observedAt: '2026-09-15T09:30:00.000Z' },
    argumentsMatchSubject: true,
    ...overrides,
  };
}

function args(overrides: Partial<Args> = {}): Args {
  return {
    guardrail: { tier: 3 } as Args['guardrail'],
    approvalScope: 'supervised',
    agentRun: { id: 'run-1' } as Args['agentRun'],
    toolName: 'manage_services',
    input: { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' },
    agentMode: 'act',
    hasScope: true,
    triggerKind: 'sweep_finding',
    sweepAct: sweepAct(),
    ...overrides,
  };
}

const PRIOR = {
  sweep: process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED,
  decide: process.env.BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED,
};

beforeEach(() => {
  process.env.BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED = 'true';
  process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = 'true';
});

afterEach(() => {
  for (const [name, value] of [
    ['BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED', PRIOR.sweep],
    ['BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED', PRIOR.decide],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('resolvePolicyDecisionState — the sweep act allowance', () => {
  it('all gates satisfied -> unattempted', () => {
    expect(resolve(args())).toBe('unattempted');
  });

  it.each<[string, () => Args]>([
    ['sub-flag off', () => {
      process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = 'false';
      return args();
    }],
    ['policy-decide flag off', () => {
      process.env.BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED = 'false';
      return args();
    }],
    ['trigger_kind is not sweep_finding', () => args({ triggerKind: 'ticket' })],
    ['trigger_kind is alert', () => args({ triggerKind: 'alert' })],
    ['no trigger at all', () => args({ triggerKind: undefined })],
    ['schedule not armed', () => args({ sweepAct: sweepAct({ scheduleActMode: false }) })],
    ['no trusted subject', () => args({ sweepAct: undefined })],
    ['arguments do not match the subject', () => args({ sweepAct: sweepAct({ argumentsMatchSubject: false }) })],
    ['tier < 3', () => args({ guardrail: { tier: 2 } as Args['guardrail'] })],
    ['approvalScope four_eyes', () => args({ approvalScope: 'four_eyes' })],
    ['run snapshot mode is shadow', () => args({ agentMode: 'shadow' })],
    ['no agent run', () => args({ agentRun: null as unknown as Args['agentRun'] })],
  ])('%s -> human_required', (_name, build) => {
    expect(resolve(build())).toBe('human_required');
  });

  it('a device scope from a NON-sweep caller is still human_required — the allowance keys on trigger_kind, not on having a scope', () => {
    expect(resolve(args({ triggerKind: 'ticket', sweepAct: sweepAct() }))).toBe('human_required');
  });

  it('leaves the run-bound (unscoped) policy-decide lane exactly as it was', () => {
    expect(resolve(args({ hasScope: false, triggerKind: 'alert', sweepAct: undefined }))).toBe('unattempted');
  });
});

describe('subjectMatchesArguments', () => {
  const subject = { kind: 'service_down' as const, key: 'Spooler', observedAt: null };

  it('matches a manage_services restart naming exactly that service on the scope device', () => {
    expect(subjectMatchesArguments(subject, 'manage_services', {
      action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler',
    }, DEVICE_ID)).toBe(true);
  });

  it('refuses a DIFFERENT service on the same device — the substitution case', () => {
    expect(subjectMatchesArguments(subject, 'manage_services', {
      action: 'restart', deviceId: DEVICE_ID, serviceName: 'W32Time',
    }, DEVICE_ID)).toBe(false);
  });

  it('refuses when the argument device is not the scope device', () => {
    expect(subjectMatchesArguments(subject, 'manage_services', {
      action: 'restart', deviceId: OTHER_DEVICE_ID, serviceName: 'Spooler',
    }, DEVICE_ID)).toBe(false);
  });

  it('refuses any tool that is not the single act-mode op key in v1', () => {
    expect(subjectMatchesArguments(
      { kind: 'unpatched_critical', key: 'dv-a', observedAt: null },
      'remediate_vulnerability',
      { deviceId: DEVICE_ID, deviceVulnerabilityIds: ['dv-a'] },
      DEVICE_ID,
    )).toBe(false);
  });

  it('refuses a malformed argument bag rather than treating missing as matching', () => {
    expect(subjectMatchesArguments(subject, 'manage_services', {}, DEVICE_ID)).toBe(false);
    expect(subjectMatchesArguments(subject, 'manage_services', {
      action: 'stop', deviceId: DEVICE_ID, serviceName: 'Spooler',
    }, DEVICE_ID)).toBe(false);
  });

  it('refuses a subject kind that is not act-eligible even with matching arguments', () => {
    expect(subjectMatchesArguments(
      { kind: 'disk_pressure', key: 'Spooler', observedAt: null },
      'manage_services',
      { action: 'restart', deviceId: DEVICE_ID, serviceName: 'Spooler' },
      DEVICE_ID,
    )).toBe(false);
  });
});
