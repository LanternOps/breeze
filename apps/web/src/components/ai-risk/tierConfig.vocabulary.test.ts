import { describe, expect, it } from 'vitest';
import { TIER_DEFINITIONS } from './tierConfig';

/**
 * AI surface cohesion W04 (#10135): the tier explainer is customer-facing copy,
 * so it follows the spec §6 vocabulary — the unit of Operator work is an
 * "AI task", and "Operator" never names the software. Tool NAMES are
 * identifiers (`operator_plan`, `launch_specialist (operator_recipe/…)`) and
 * must not change (apps/api aiToolsAiAgentGovernance parity test).
 */
describe('tierConfig descriptions use the AI task vocabulary', () => {
  const entries = TIER_DEFINITIONS.flatMap((tier) => tier.tools);

  it('never calls the software "Operator" in a description', () => {
    const offenders = entries
      .filter((entry) => /\bOperator\b/.test(entry.description ?? ''))
      .map((entry) => `${entry.name}: ${entry.description}`);
    expect(offenders).toEqual([]);
  });

  it('keeps the governance tool names as identifiers', () => {
    const names = entries.map((entry) => entry.name);
    expect(names).toContain('operator_plan');
    expect(names).toContain('launch_specialist (operator_recipe/patch_plan/remediation_research/bulk_ticket_reply)');
    const plan = entries.find((entry) => entry.name === 'operator_plan');
    expect(plan?.description).toBe('Approve an AI task plan: one four-eyes decision over an ordered set of provider effects');
  });
});
