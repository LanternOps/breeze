import { describe, expect, it, vi } from 'vitest';

/**
 * Tool Catalog W06 (#5221) Task A7, plan Decision 16 — whether a standalone
 * Job is a compliance-remediation target ("S+R"): named explicitly by an
 * automation policy rule, or matched by script by EITHER remediation consumer
 * (compliance automation policies; config-policy compliance rules) within
 * the Job's partner. Such a row never converts in W06.
 */

import { isComplianceRemediationTarget, remediationScriptIdsOf } from './policyEvaluationService';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const SCRIPT = '33333333-3333-4333-8333-333333333333';
const JOB = '66666666-6666-4666-8666-666666666666';

/** A fake executor answering the three probes in order: explicit, compliance-policy script, config-rule script. */
function database(answers: Array<Array<{ hit: number }>>) {
  const calls: string[] = [];
  return {
    calls,
    execute: vi.fn(async (q: { queryChunks?: unknown[] }) => {
      calls.push(JSON.stringify(q).slice(0, 2000));
      return answers.shift() ?? [];
    }),
  };
}

const job = (actions: unknown[]) => ({ id: JOB, orgId: ORG, partnerId: null, actions });

describe('isComplianceRemediationTarget', () => {
  it('script ids come from run_script actions, both spellings', () => {
    expect(remediationScriptIdsOf([{ type: 'run_script', scriptId: SCRIPT }, { type: 'run_script', script_id: 'b' }, { type: 'send_notification' }]))
      .toEqual([SCRIPT, 'b']);
  });

  it('an explicit remediationAutomationId names the Job', async () => {
    const d = database([[{ hit: 1 }]]);
    expect(await isComplianceRemediationTarget(d as never, job([]), PARTNER)).toBe(true);
    expect(d.execute).toHaveBeenCalledTimes(1);
  });

  it('S+R row is a blocker for both consumers', async () => {
    // compliance automation policy script match
    expect(await isComplianceRemediationTarget(database([[], [{ hit: 1 }]]) as never, job([{ type: 'run_script', scriptId: SCRIPT }]), PARTNER)).toBe(true);
    // config-policy compliance rule script match
    expect(await isComplianceRemediationTarget(database([[], [], [{ hit: 1 }]]) as never, job([{ type: 'run_script', scriptId: SCRIPT }]), PARTNER)).toBe(true);
    // neither
    expect(await isComplianceRemediationTarget(database([[], [], []]) as never, job([{ type: 'run_script', scriptId: SCRIPT }]), PARTNER)).toBe(false);
  });

  it('a Job with no script is only an explicit target (no script probes)', async () => {
    const d = database([[]]);
    expect(await isComplianceRemediationTarget(d as never, job([{ type: 'create_alert' }]), PARTNER)).toBe(false);
    expect(d.execute).toHaveBeenCalledTimes(1);
  });
});
