import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'crypto';

// intentService's import graph reaches the postgres pool and the whole AI tool
// registry. These cases exercise two PURE exports, so the graph is stubbed to
// whatever shape import-time evaluation needs and nothing more.
vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import {
  deriveIdempotencyKey,
  deriveIntentIdempotencyKey,
  isSameTaskOperationReuse,
} from './intentService';

const TASK_A = '11111111-1111-4111-8111-111111111111';
const TASK_B = '22222222-2222-4222-8222-222222222222';
const RUN_A = '33333333-3333-4333-8333-333333333333';
const RUN_B = '44444444-4444-4444-8444-444444444444';
const DIGEST = 'a'.repeat(64);

const sha = (material: string) => createHash('sha256').update(material).digest('hex');

describe('deriveIntentIdempotencyKey (baseline C6/H1 — one arbiter)', () => {
  const base = {
    explicitKey: undefined,
    toolName: 'manage_services',
    argumentDigest: DIGEST,
    actorId: RUN_A,
    scopeId: null as string | null,
  };

  it('keys a task-linked intent on TASK identity, not run identity', () => {
    const key = deriveIntentIdempotencyKey({
      ...base,
      taskContext: { taskId: TASK_A, operationKey: 'restart:spooler:1' },
    });
    // Spelled out rather than round-tripped through the helper: this is the
    // hashed material contract, and a test that just calls the same function
    // twice would pass on any material at all.
    expect(key).toBe(sha(`task:${TASK_A}:manage_services:${DIGEST}:restart:spooler:1`));
  });

  it('yields the SAME key for a continuation run re-proposing the same operation', () => {
    const forRunA = deriveIntentIdempotencyKey({
      ...base,
      actorId: RUN_A,
      taskContext: { taskId: TASK_A, operationKey: 'restart:spooler:1' },
    });
    const forRunB = deriveIntentIdempotencyKey({
      ...base,
      actorId: RUN_B,
      taskContext: { taskId: TASK_A, operationKey: 'restart:spooler:1' },
    });
    // This is the whole point: attempt 2 of a task converges on attempt 1's
    // live intent through the EXISTING partial unique index rather than
    // minting a second intent.
    expect(forRunB).toBe(forRunA);
  });

  it('yields DIFFERENT keys for two tasks proposing byte-identical arguments', () => {
    const a = deriveIntentIdempotencyKey({
      ...base,
      taskContext: { taskId: TASK_A, operationKey: 'restart:spooler:1' },
    });
    const b = deriveIntentIdempotencyKey({
      ...base,
      taskContext: { taskId: TASK_B, operationKey: 'restart:spooler:1' },
    });
    expect(b).not.toBe(a);
  });

  it('yields DIFFERENT keys for two operations of the SAME task', () => {
    const a = deriveIntentIdempotencyKey({
      ...base,
      taskContext: { taskId: TASK_A, operationKey: 'restart:spooler:1' },
    });
    const b = deriveIntentIdempotencyKey({
      ...base,
      taskContext: { taskId: TASK_A, operationKey: 'restart:spooler:2' },
    });
    expect(b).not.toBe(a);
  });

  it('leaves the legacy run-scoped derivation byte-identical', () => {
    expect(deriveIntentIdempotencyKey({ ...base, taskContext: null }))
      .toBe(deriveIdempotencyKey(RUN_A, 'manage_services', DIGEST, null));
    expect(deriveIntentIdempotencyKey({ ...base, taskContext: null, scopeId: 'dev-1' }))
      .toBe(deriveIdempotencyKey(RUN_A, 'manage_services', DIGEST, 'dev-1'));
  });

  it('honours an explicit key on the legacy path only', () => {
    expect(deriveIntentIdempotencyKey({ ...base, taskContext: null, explicitKey: 'mine' }))
      .toBe('mine');
    // On the task path an explicit key is rejected by createActionIntent before
    // this function is reached; if one ever arrives here, task identity wins so
    // the single-arbiter invariant cannot be bypassed by a coding error.
    expect(
      deriveIntentIdempotencyKey({
        ...base,
        explicitKey: 'mine',
        taskContext: { taskId: TASK_A, operationKey: 'op' },
      }),
    ).not.toBe('mine');
  });

  it('cannot be collided by a legacy caller, because a UUID actor cannot carry the task: prefix', () => {
    const taskKey = deriveIntentIdempotencyKey({
      ...base,
      taskContext: { taskId: TASK_A, operationKey: 'op' },
    });
    // The nearest legacy shape: same tool, same digest, the task id as the
    // actor and the operation key as the scope. Different material, because
    // the legacy branch has no `task:` prefix.
    const legacyLookalike = deriveIntentIdempotencyKey({
      ...base,
      taskContext: null,
      actorId: TASK_A,
      scopeId: 'op',
    });
    expect(legacyLookalike).not.toBe(taskKey);
  });
});

describe('isSameTaskOperationReuse (baseline §5.2 — the relaxation predicate)', () => {
  const ctx = { taskId: TASK_A, operationKey: 'restart:spooler:1' };

  it('is true only when both the task and the operation match', () => {
    expect(isSameTaskOperationReuse({ taskId: TASK_A, operationKey: 'restart:spooler:1' }, ctx))
      .toBe(true);
  });

  it.each([
    ['a different task', { taskId: TASK_B, operationKey: 'restart:spooler:1' }],
    ['a different operation', { taskId: TASK_A, operationKey: 'restart:spooler:2' }],
    ['a LEGACY task-less intent', { taskId: null, operationKey: null }],
    ['a task-less intent that somehow carries an operation key', { taskId: null, operationKey: 'restart:spooler:1' }],
  ])('is false for %s', (_label, existing) => {
    expect(isSameTaskOperationReuse(existing, ctx)).toBe(false);
  });

  it('is false for every existing row when the caller supplied no task context', () => {
    expect(isSameTaskOperationReuse({ taskId: TASK_A, operationKey: 'restart:spooler:1' }, null))
      .toBe(false);
    expect(isSameTaskOperationReuse({ taskId: null, operationKey: null }, null)).toBe(false);
  });
});
