import type { z } from 'zod';
import type { MonitorKind } from '@breeze/shared';
import type { AlertCondition } from '../../alertConditions/types';

/**
 * A monitor kind's registration: the AUTHORING condition shape (`conditionSchema`,
 * from `@breeze/shared`'s `monitorConditionSchemas`) plus everything the compiler
 * (Task 4) needs to turn one authored condition into the handler-shaped
 * `RootCondition` the existing `alertConditions` evaluator already understands.
 *
 * `C` is the parsed authoring shape for this kind (e.g. `{ operator, value,
 * durationMinutes? }` for `cpu`) — every kind file supplies its own concrete `C`.
 */
export interface MonitorKindSpec<C = Record<string, unknown>> {
  kind: MonitorKind;
  /** Authoring schema from `@breeze/shared` — the shape the editor collects. */
  conditionSchema: z.ZodType<C>;
  /** Keys a config-policy attachment override is allowed to touch (see `applyOverrides`). */
  overridableKeys: readonly (keyof C & string)[];
  defaultSeverity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  /**
   * Compiles the authored condition into the handler-shaped object `alertConditions`
   * evaluates, including its `type`. Typed as `AlertCondition` (a leaf), not the
   * broader `RootCondition` union — every kind compiles to exactly one leaf
   * condition, never an `{logic, conditions[]}` group, and callers (the test in
   * this package included) read `.type` off the result, which `ConditionGroup`
   * does not have.
   */
  toAlertCondition(condition: C): AlertCondition;
  titleTemplate: string;
  messageTemplate: string;
  /**
   * True when the handler type is delivered/evaluated by the agent itself
   * (service/process watches) rather than the server-side sweep. Kept on the
   * spec until the agent-delivered watch path (W4) exists so callers can branch
   * on it without re-deriving the handler-type list.
   */
  agentDelivered: boolean;
}

/** Thrown by `getMonitorKindSpec` for an unknown kind and by `applyOverrides` when a merged override fails re-validation. */
export class MonitorValidationError extends Error {}
