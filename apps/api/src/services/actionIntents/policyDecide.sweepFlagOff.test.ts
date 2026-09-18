/**
 * #4442 W04 — THE FLAG-OFF REGRESSION CONTROL.
 *
 * This wave replaces `resolvePolicyDecisionState`'s blanket
 * `if (args.hasScope) return 'human_required'` with a five-condition
 * allowance. The one property that must survive every later task is that with
 * `BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED` false the function is BYTE-IDENTICAL to
 * what shipped before this wave: every scoped intent is `human_required`, and
 * nothing downstream of the flag is even evaluated.
 *
 * Written BEFORE any gate change (plan Task 3 Step 1) and green on the
 * unmodified code, so it discriminates a gate LEAKING OUT from behind its flag
 * rather than merely confirming the new code. The "reads nothing else" case is
 * the half a verdict-only assertion cannot catch: a gate that queries the
 * schedule or the subject before it checks the flag is a behaviour change even
 * when the answer it returns is the same.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  __resolvePolicyDecisionStateForTest as resolve,
  type SweepActEligibility,
} from './intentService';

type Args = Parameters<typeof resolve>[0];

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

function sweepAct(overrides: Partial<SweepActEligibility> = {}): SweepActEligibility {
  return {
    scheduleActMode: true,
    subject: { kind: 'service_down', key: 'Spooler', observedAt: '2026-09-15T00:00:00.000Z' },
    argumentsMatchSubject: true,
    ...overrides,
  };
}

/** A fully act-eligible sweep intent: every gate this wave adds is satisfied. */
function sweepIntentArgs(overrides: Partial<Args> = {}): Args {
  return {
    guardrail: { tier: 3 } as Args['guardrail'],
    approvalScope: 'supervised',
    agentRun: { id: 'run-1' } as Args['agentRun'],
    toolName: 'manage_services',
    input: { deviceId: DEVICE_ID, serviceName: 'Spooler', action: 'restart' },
    agentMode: 'act',
    hasScope: true,
    triggerKind: 'sweep_finding',
    sweepAct: sweepAct(),
    ...overrides,
  };
}

const PRIOR_SWEEP_FLAG = process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED;
const PRIOR_DECIDE_FLAG = process.env.BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED;

beforeEach(() => {
  // The OUTER flag is ON for every case here: this suite is about the sweep
  // sub-flag alone. With policy-decide itself off, everything returns
  // human_required for a reason that has nothing to do with this wave.
  process.env.BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED = 'true';
  process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = 'false';
});

afterEach(() => {
  if (PRIOR_SWEEP_FLAG === undefined) delete process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED;
  else process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = PRIOR_SWEEP_FLAG;
  if (PRIOR_DECIDE_FLAG === undefined) delete process.env.BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED;
  else process.env.BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED = PRIOR_DECIDE_FLAG;
});

describe('BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED=false is byte-identical to today', () => {
  it.each<[string, Args]>([
    ['sweep-minted, schedule armed, subject present', sweepIntentArgs()],
    ['sweep-minted, schedule NOT armed', sweepIntentArgs({ sweepAct: sweepAct({ scheduleActMode: false }) })],
    ['sweep-minted, no trusted subject', sweepIntentArgs({ sweepAct: undefined })],
    ['ticket-scoped', sweepIntentArgs({ triggerKind: 'ticket', sweepAct: undefined })],
    ['device-scoped from a non-sweep caller', sweepIntentArgs({ triggerKind: null, sweepAct: undefined })],
  ])('%s -> human_required', (_name, args) => {
    expect(resolve(args)).toBe('human_required');
  });

  it('does not read the schedule, the subject or the probe when the flag is off', () => {
    // Property getters standing in for the injected loaders: the gate is pure
    // and takes its act inputs as DATA, so "never queried" is expressed here
    // as "never even read off the argument object".
    const touched: string[] = [];
    const args = sweepIntentArgs();
    const spied = {
      ...args,
      get triggerKind() { touched.push('triggerKind'); return 'sweep_finding'; },
      get sweepAct() { touched.push('sweepAct'); return sweepAct(); },
    } as Args;

    expect(resolve(spied)).toBe('human_required');
    expect(touched).toEqual([]);
  });

  it('leaves the NON-sweep policy-decide lane completely untouched', () => {
    // The whole point of a second flag: an alert-triggered, run-bound intent
    // (no scope at all) is still decidable with the sweep lane disarmed.
    expect(resolve(sweepIntentArgs({ hasScope: false, triggerKind: 'alert', sweepAct: undefined })))
      .toBe('unattempted');
  });
});
