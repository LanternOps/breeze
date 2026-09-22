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
  AI_OPERATOR_ACCOUNT_PROVIDERS as SHARED_ACCOUNT_PROVIDERS,
  AI_OPERATOR_EVENT_ACTOR_KINDS as SHARED_EVENT_ACTOR_KINDS,
  AI_OPERATOR_STEP_KINDS as SHARED_STEP_KINDS,
  AI_OPERATOR_STEP_STATES as SHARED_STEP_STATES,
  AI_OPERATOR_TARGET_KINDS as SHARED_TARGET_KINDS,
  AI_OPERATOR_TARGET_STATES as SHARED_TARGET_STATES,
  AI_OPERATOR_TASK_EVENT_TYPES as SHARED_TASK_EVENT_TYPES,
} from '@breeze/shared';
import {
  AI_OPERATOR_EXECUTION_REF_KINDS as SCHEMA_EXECUTION_REF_KINDS,
  AI_OPERATOR_TARGET_DETACH_REASONS as SCHEMA_TARGET_DETACH_REASONS,
  AI_OPERATOR_TASK_OUTCOMES as SCHEMA_TASK_OUTCOMES,
  AI_OPERATOR_TASK_PHASES as SCHEMA_TASK_PHASES,
  AI_OPERATOR_TASK_STATES as SCHEMA_TASK_STATES,
  AI_OPERATOR_WAIT_REASONS as SCHEMA_WAIT_REASONS,
} from '../../db/schema/aiOperatorTasks';
import {
  AI_OPERATOR_ACCOUNT_PROVIDERS as SCHEMA_ACCOUNT_PROVIDERS,
  AI_OPERATOR_EVENT_ACTOR_KINDS as SCHEMA_EVENT_ACTOR_KINDS,
  AI_OPERATOR_STEP_KINDS as SCHEMA_STEP_KINDS,
  AI_OPERATOR_STEP_STATES as SCHEMA_STEP_STATES,
  AI_OPERATOR_TARGET_KINDS as SCHEMA_TARGET_KINDS,
  AI_OPERATOR_TARGET_STATES as SCHEMA_TARGET_STATES,
  AI_OPERATOR_TASK_EVENT_TYPES as SCHEMA_TASK_EVENT_TYPES,
} from '../../db/schema/aiOperatorTaskGraph';
import {
  STEP_KINDS as RECIPE_STEP_KINDS,
  TARGET_KINDS as RECIPE_TARGET_KINDS,
} from './recipes/types';

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

  // Wave E2 task-graph lists (recipe spec §5.1-§5.3).
  it('AI_OPERATOR_TARGET_KINDS matches byte-for-byte', () => {
    expect([...SHARED_TARGET_KINDS]).toEqual([...SCHEMA_TARGET_KINDS]);
  });

  it('AI_OPERATOR_TARGET_STATES matches byte-for-byte', () => {
    expect([...SHARED_TARGET_STATES]).toEqual([...SCHEMA_TARGET_STATES]);
  });

  it('AI_OPERATOR_STEP_KINDS matches byte-for-byte', () => {
    expect([...SHARED_STEP_KINDS]).toEqual([...SCHEMA_STEP_KINDS]);
  });

  it('AI_OPERATOR_STEP_STATES matches byte-for-byte', () => {
    expect([...SHARED_STEP_STATES]).toEqual([...SCHEMA_STEP_STATES]);
  });

  it('AI_OPERATOR_ACCOUNT_PROVIDERS matches byte-for-byte', () => {
    expect([...SHARED_ACCOUNT_PROVIDERS]).toEqual([...SCHEMA_ACCOUNT_PROVIDERS]);
  });

  it('AI_OPERATOR_TASK_EVENT_TYPES matches byte-for-byte', () => {
    expect([...SHARED_TASK_EVENT_TYPES]).toEqual([...SCHEMA_TASK_EVENT_TYPES]);
  });

  it('the event-type list ends with human_work_unticked then task_settled, in all three copies', () => {
    // The third copy is the CHECK constraint in
    // migrations/2026-10-26-170100-ai-operator-human-work-links.sql section 3;
    // aiOperatorHumanWorkStep.integration.test.ts proves that one against the
    // live database. Here we pin the two TypeScript copies to each other.
    expect([...SCHEMA_TASK_EVENT_TYPES]).toEqual([...SHARED_TASK_EVENT_TYPES]);
    expect(SHARED_TASK_EVENT_TYPES).toContain('human_work_unticked');
    expect(SHARED_TASK_EVENT_TYPES.at(-2)).toBe('human_work_unticked');
    expect(SHARED_TASK_EVENT_TYPES.at(-1)).toBe('task_settled');
  });

  it('AI_OPERATOR_EVENT_ACTOR_KINDS matches byte-for-byte', () => {
    expect([...SHARED_EVENT_ACTOR_KINDS]).toEqual([...SCHEMA_EVENT_ACTOR_KINDS]);
  });

  // THREE copies of the target/step kinds, not two: E1's recipe registry has
  // its own TARGET_KINDS/STEP_KINDS (recipe spec §6.1), and a recipe that
  // declares a kind the CHECK constraint does not permit fails at INSERT
  // time, in production, on a real task. Pin them with the other two.
  it('the recipe registry TARGET_KINDS matches the DB/wire target kinds', () => {
    expect([...RECIPE_TARGET_KINDS]).toEqual([...SCHEMA_TARGET_KINDS]);
  });

  it('the recipe registry STEP_KINDS matches the DB/wire step kinds', () => {
    expect([...RECIPE_STEP_KINDS]).toEqual([...SCHEMA_STEP_KINDS]);
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

type _ModeParity = MutuallyAssignable<AiOperatorTaskMode, SchemaMode> extends true ? true : never;
type _OriginKindParity = MutuallyAssignable<AiOperatorTaskOriginKind, SchemaOriginKind> extends true ? true : never;
type _WaitDependencyKindParity =
  MutuallyAssignable<AiOperatorWaitDependencyKind, SchemaWaitDependencyKind> extends true ? true : never;
type _DispatchStateParity =
  MutuallyAssignable<AiOperatorOperationDispatchState, SchemaDispatchState> extends true ? true : never;
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
