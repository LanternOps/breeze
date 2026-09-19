// apps/api/src/services/aiOperator/operationKey.test.ts
import { describe, expect, it } from 'vitest';
import {
  OPERATION_KEY_MAX_LENGTH,
  buildTaskOperationKey,
  type TaskOperationKeyParts,
} from './operationKey';

const BASE: TaskOperationKeyParts = {
  taskStepKey: 'execute',
  planRevision: 3,
  toolName: 'manage_services',
  targetId: '00000000-0000-4000-8000-000000000001',
  ordinal: 0,
};

describe('buildTaskOperationKey (spec §6.5)', () => {
  it('is deterministic: identical inputs produce identical keys', () => {
    const a = buildTaskOperationKey(BASE);
    const b = buildTaskOperationKey({ ...BASE });
    expect(a).toBe(b);
  });

  it('a different planRevision produces a different key', () => {
    const a = buildTaskOperationKey(BASE);
    const b = buildTaskOperationKey({ ...BASE, planRevision: BASE.planRevision + 1 });
    expect(a).not.toBe(b);
  });

  it('a different ordinal produces a different key', () => {
    const a = buildTaskOperationKey(BASE);
    const b = buildTaskOperationKey({ ...BASE, ordinal: BASE.ordinal + 1 });
    expect(a).not.toBe(b);
  });

  it('attemptOrdinal is not part of the identity: two calls that differ only in the ' +
    'attempt the caller is on converge on the same key', () => {
    // `TaskOperationKeyParts` has no `attemptOrdinal` field at all — a
    // continuation run re-proposing the SAME operation must attach to the
    // EXISTING row rather than minting a second one for a human to approve
    // twice (spec §6.5). Calling with identical args twice, as if from
    // attempt 1 and attempt 2 of the same reasoning chain, must converge.
    const attempt1 = buildTaskOperationKey(BASE);
    const attempt2 = buildTaskOperationKey(BASE);
    expect(attempt1).toBe(attempt2);
  });

  it('sanitises punctuation, and two DIFFERENT identities can collide as a result ' +
    '(bounded: step keys come from a fixed recipe list, never user input)', () => {
    // The implementation replaces every character outside [A-Za-z0-9_.-] with
    // `_`. 'a:b' and 'a_b' both sanitise to 'a_b', so they DO collide. This is
    // the actual, accepted behaviour — not a bug — because `taskStepKey`
    // values only ever come from a recipe's fixed `SERVICE_RECOVERY_STEP_KEYS`
    // list (or equivalent), never from user- or model-authored text.
    const withColon = buildTaskOperationKey({ ...BASE, taskStepKey: 'a:b' });
    const withUnderscore = buildTaskOperationKey({ ...BASE, taskStepKey: 'a_b' });
    expect(withColon).toBe(withUnderscore);
  });

  it('stays within OPERATION_KEY_MAX_LENGTH even for long components', () => {
    const key = buildTaskOperationKey({
      taskStepKey: 'x'.repeat(200),
      planRevision: 999999,
      toolName: 'y'.repeat(200),
      targetId: 'z'.repeat(200),
      ordinal: 999999,
    });
    expect(key.length).toBeLessThanOrEqual(OPERATION_KEY_MAX_LENGTH);
  });

  it('targetId null renders as the literal "none" segment', () => {
    const key = buildTaskOperationKey({ ...BASE, targetId: null });
    expect(key).toContain(':none:');
  });
});
