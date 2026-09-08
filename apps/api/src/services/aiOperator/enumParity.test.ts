/**
 * Parity contract between `packages/shared/src/types/aiOperator.ts`'s
 * CHECK-mirroring unions and `apps/api/src/db/schema/aiOperatorTasks.ts`'s own
 * copies (review fix, PR #5254 — three independent reviewers flagged the same
 * risk: `packages/shared` cannot import the db schema module, so these lists
 * are hand-duplicated, and nothing previously caught them drifting apart).
 *
 * The concrete failure mode this guards: `computeOperatorTaskNextAction`
 * (`taskReadService.ts`) switches exhaustively over the SHARED
 * `AiOperatorTaskState`/`AiOperatorWaitReason` types, but the value it
 * actually receives at runtime is whatever the DB schema's own (separately
 * declared) union allows through a `row as OperatorTaskRowInput` cast at the
 * route layer. If the schema gained a new state/phase/wait-reason/outcome/
 * detach-reason/execution-ref-kind that this file's copy didn't, the switch's
 * compile-time exhaustiveness would prove nothing — the new value would just
 * silently fall through to an implicit `undefined` return at runtime, shipping
 * `nextAction: undefined` on the wire. This is exactly the class of bug
 * CLAUDE.md's cascade-list section calls "a mechanical grep, not a judgement
 * call, [that] code review has caught 0/5 times" — same shape, different
 * table family.
 *
 * `apps/api` can import both sides (shared package + its own db schema), so
 * this lives here rather than in either individual package.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_OPERATOR_EXECUTION_REF_KINDS as SHARED_EXECUTION_REF_KINDS,
  AI_OPERATOR_TARGET_DETACH_REASONS as SHARED_TARGET_DETACH_REASONS,
  AI_OPERATOR_TASK_OUTCOMES as SHARED_TASK_OUTCOMES,
  AI_OPERATOR_TASK_PHASES as SHARED_TASK_PHASES,
  AI_OPERATOR_TASK_STATES as SHARED_TASK_STATES,
  AI_OPERATOR_WAIT_REASONS as SHARED_WAIT_REASONS,
} from '@breeze/shared';
import {
  AI_OPERATOR_EXECUTION_REF_KINDS as SCHEMA_EXECUTION_REF_KINDS,
  AI_OPERATOR_TARGET_DETACH_REASONS as SCHEMA_TARGET_DETACH_REASONS,
  AI_OPERATOR_TASK_OUTCOMES as SCHEMA_TASK_OUTCOMES,
  AI_OPERATOR_TASK_PHASES as SCHEMA_TASK_PHASES,
  AI_OPERATOR_TASK_STATES as SCHEMA_TASK_STATES,
  AI_OPERATOR_WAIT_REASONS as SCHEMA_WAIT_REASONS,
} from '../../db/schema/aiOperatorTasks';

describe('AI Operator enum parity — shared package vs. db schema', () => {
  it('AI_OPERATOR_TASK_STATES matches byte-for-byte', () => {
    expect([...SHARED_TASK_STATES]).toEqual([...SCHEMA_TASK_STATES]);
  });

  it('AI_OPERATOR_TASK_PHASES matches byte-for-byte', () => {
    expect([...SHARED_TASK_PHASES]).toEqual([...SCHEMA_TASK_PHASES]);
  });

  it('AI_OPERATOR_WAIT_REASONS matches byte-for-byte', () => {
    expect([...SHARED_WAIT_REASONS]).toEqual([...SCHEMA_WAIT_REASONS]);
  });

  it('AI_OPERATOR_TASK_OUTCOMES matches byte-for-byte', () => {
    expect([...SHARED_TASK_OUTCOMES]).toEqual([...SCHEMA_TASK_OUTCOMES]);
  });

  it('AI_OPERATOR_TARGET_DETACH_REASONS matches byte-for-byte', () => {
    expect([...SHARED_TARGET_DETACH_REASONS]).toEqual([...SCHEMA_TARGET_DETACH_REASONS]);
  });

  it('AI_OPERATOR_EXECUTION_REF_KINDS matches byte-for-byte', () => {
    expect([...SHARED_EXECUTION_REF_KINDS]).toEqual([...SCHEMA_EXECUTION_REF_KINDS]);
  });
});

/**
 * `mode`, `originKind`, `waitDependencyKind`, `dispatchState`, `resultState`
 * have no second runtime array to compare — the schema declares them as
 * inline `.$type<'a' | 'b'>()` literal unions (`db/schema/aiOperatorTasks.ts`),
 * not exported consts. A compile-time mutual-extends check closes the same
 * gap with zero runtime cost: if either side gains/loses a member, one of
 * these two conditional types resolves to `false` and the assignment below
 * fails `tsc`, not silently.
 */
import type {
  AiOperatorOperationDispatchState,
  AiOperatorOperationResultState,
  AiOperatorTaskMode,
  AiOperatorTaskOriginKind,
  AiOperatorWaitDependencyKind,
} from '@breeze/shared';
import type { aiOperatorOperations, aiOperatorTasks } from '../../db/schema/aiOperatorTasks';

type SchemaMode = NonNullable<(typeof aiOperatorTasks.$inferSelect)['mode']>;
type SchemaOriginKind = (typeof aiOperatorTasks.$inferSelect)['originKind'];
type SchemaWaitDependencyKind = NonNullable<(typeof aiOperatorTasks.$inferSelect)['waitDependencyKind']>;
type SchemaDispatchState = (typeof aiOperatorOperations.$inferSelect)['dispatchState'];
type SchemaResultState = (typeof aiOperatorOperations.$inferSelect)['resultState'];

// Tuple-wrapped (`[A] extends [B]`) to suppress conditional-type
// DISTRIBUTION over the union members of A/B — without it, `A extends B ?
// X : Y` for a union `A` evaluates X/Y per-member and recombines into a
// union of results (e.g. `boolean`) instead of one true/false, which made an
// earlier version of this check silently resolve to `never` for every entry
// regardless of whether the two sides actually matched (caught by `tsc`,
// not by the vitest transform, which doesn't type-check — review fix, PR
// #5254).
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ModeParity = MutuallyAssignable<AiOperatorTaskMode, SchemaMode> extends true ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _OriginKindParity = MutuallyAssignable<AiOperatorTaskOriginKind, SchemaOriginKind> extends true ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _WaitDependencyKindParity =
  MutuallyAssignable<AiOperatorWaitDependencyKind, SchemaWaitDependencyKind> extends true ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _DispatchStateParity =
  MutuallyAssignable<AiOperatorOperationDispatchState, SchemaDispatchState> extends true ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ResultStateParity = MutuallyAssignable<AiOperatorOperationResultState, SchemaResultState> extends true ? true : never;

// A single runtime test to anchor the compile-time checks above to a real
// `it()` — otherwise a `tsc` failure in the types above would not surface in
// a `vitest run` (test-only) invocation, only in a separate typecheck step.
describe('AI Operator inline-union parity — shared package vs. db schema (compile-time)', () => {
  it('type-level mutual-assignability checks above compiled (see _ModeParity etc.)', () => {
    const modeCheck: _ModeParity = true;
    const originKindCheck: _OriginKindParity = true;
    const waitDependencyKindCheck: _WaitDependencyKindParity = true;
    const dispatchStateCheck: _DispatchStateParity = true;
    const resultStateCheck: _ResultStateParity = true;
    expect([modeCheck, originKindCheck, waitDependencyKindCheck, dispatchStateCheck, resultStateCheck]).toEqual([
      true, true, true, true, true,
    ]);
  });
});
