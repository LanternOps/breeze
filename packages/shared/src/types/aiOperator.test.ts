// packages/shared/src/types/aiOperator.test.ts
import { describe, expect, it } from 'vitest';
import {
  AI_OPERATOR_ACCOUNT_PROVIDERS,
  AI_OPERATOR_EVENT_ACTOR_KINDS,
  AI_OPERATOR_STEP_KINDS,
  AI_OPERATOR_STEP_STATES,
  AI_OPERATOR_TARGET_KINDS,
  AI_OPERATOR_TARGET_STATES,
  AI_OPERATOR_TASK_EVENT_TYPES,
} from './aiOperator';

describe('AI Operator task-graph value lists (recipe spec §5.1/§5.2/§5.3)', () => {
  it('target kinds are exactly device, ticket, contact — in that order', () => {
    expect([...AI_OPERATOR_TARGET_KINDS]).toEqual(['device', 'ticket', 'contact']);
  });

  it('step kinds are exactly the six of recipe spec §5.3', () => {
    expect([...AI_OPERATOR_STEP_KINDS]).toEqual([
      'reason', 'effect', 'probe', 'wait', 'human_work', 'document',
    ]);
  });

  it('target states end with detached, which is what a detach stamp sets', () => {
    expect([...AI_OPERATOR_TARGET_STATES]).toEqual([
      'pending', 'active', 'succeeded', 'failed', 'skipped', 'detached',
    ]);
  });

  it('step states are the six lifecycle values', () => {
    expect([...AI_OPERATOR_STEP_STATES]).toEqual([
      'pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped',
    ]);
  });

  it('account providers are exactly m365 and google (recipe spec §5.2)', () => {
    expect([...AI_OPERATOR_ACCOUNT_PROVIDERS]).toEqual(['m365', 'google']);
  });

  it('event actor kinds never include a synthetic human user for a machine actor', () => {
    expect([...AI_OPERATOR_EVENT_ACTOR_KINDS]).toEqual([
      'coordinator', 'reconciler', 'user', 'agent', 'system',
    ]);
  });

  it('event types are unique and cover every task-affecting transition', () => {
    expect(new Set(AI_OPERATOR_TASK_EVENT_TYPES).size).toBe(AI_OPERATOR_TASK_EVENT_TYPES.length);
    for (const required of [
      'task_admitted', 'lease_claimed', 'step_opened', 'step_settled',
      'wait_entered', 'target_attached', 'target_detached', 'human_work_unticked', 'task_settled',
    ]) {
      expect(AI_OPERATOR_TASK_EVENT_TYPES).toContain(required);
    }
  });
});
