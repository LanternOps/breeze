import { describe, expect, it } from 'vitest';
import { canonicalRemediationId, dedupeRemediations } from './remediationIdentity';

describe('canonical remediation identity', () => {
  it('collapses a script into its intent', () => {
    expect(canonicalRemediationId({ source: 'script_execution', executionId: 'e1', intentId: 'i1' })).toBe(canonicalRemediationId({ source: 'action_intent', intentId: 'i1' }));
  });
  it('collapses an automation result into its script', () => {
    expect(canonicalRemediationId({ source: 'automation_action_result', resultId: 'r1', scriptExecutionId: 'e1' })).toBe(canonicalRemediationId({ source: 'script_execution', executionId: 'e1', intentId: null }));
  });
  it('uses run and action index for inline executions', () => {
    expect(canonicalRemediationId({ source: 'agent_executed_action', runId: 'run1', actionIndex: 2 })).toBe('agent_executed_action:run1:2');
  });
  it('keeps the first row and handles empty and unrelated rows', () => {
    const a = { representation: { source: 'action_intent' as const, intentId: 'i1' } };
    const b = { representation: { source: 'script_execution' as const, executionId: 'e1', intentId: 'i1' } };
    const c = { representation: { source: 'automation_action_result' as const, resultId: 'r1', scriptExecutionId: null } };
    expect(dedupeRemediations([a, b, c])).toEqual([a, c]);
    expect(dedupeRemediations([])).toEqual([]);
  });
  it('resolves a mixed three-row chain to the intent', () => {
    const a = { representation: { source: 'automation_action_result' as const, resultId: 'r1', scriptExecutionId: 'e1' } };
    const b = { representation: { source: 'script_execution' as const, executionId: 'e1', intentId: 'i1' } };
    const c = { representation: { source: 'action_intent' as const, intentId: 'i1' } };
    expect(dedupeRemediations([a, b, c])).toEqual([a]);
  });
});
