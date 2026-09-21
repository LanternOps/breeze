import type { z } from 'zod';
import type { MonitorKind } from '@breeze/shared';
import type { RootCondition } from '../../alertConditions/types';

/**
 * A monitor kind's registration: the AUTHORING condition shape (`conditionSchema`,
 * from `@breeze/shared`'s `monitorConditionSchemas`) plus everything the compiler
 * (Task 4) needs to turn one authored condition into the handler-shaped
 * `RootCondition` the existing `alertConditions` evaluator already understands.
 *
 * `C` is the parsed authoring shape for this kind (e.g. `{ operator, value,
 * durationMinutes? }` for `cpu`) — every kind file supplies its own concrete `C`.
 */
/**
 * What a kind needs about the DEFINITION (not the authored condition) to
 * compile. Added in W04 (#5291): the `script` and `network_check` handlers both
 * read their evidence back through a row stamped with the monitor's own id, so
 * the compiled condition has to carry it. Passing it explicitly beats
 * back-filling the id in the compiler, which would silently do nothing for a
 * kind whose handler expected it.
 *
 * Every pre-W04 kind ignores the parameter — a JS function may declare fewer
 * parameters than it is called with, so none of them needed a change.
 */
export interface MonitorCompileContext {
  /** `monitor_definitions.id`. */
  monitorId: string;
}

export interface MonitorKindSpec<C = Record<string, unknown>> {
  kind: MonitorKind;
  /** Authoring schema from `@breeze/shared` — the shape the editor collects. */
  conditionSchema: z.ZodType<C>;
  /** Keys a config-policy attachment override is allowed to touch (see `applyOverrides`). */
  overridableKeys: readonly (keyof C & string)[];
  defaultSeverity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  /**
   * Compiles the authored condition into the handler-shaped object
   * `alertConditions` evaluates. Every leaf kind returns ONE `AlertCondition`;
   * `composite` (W05c1) returns a `{ logic, conditions }` group, which
   * `evaluateConditionRecursive` already walks. Callers that need `.type`
   * must narrow (`'type' in compiled`).
   */
  toAlertCondition(condition: C, ctx: MonitorCompileContext): RootCondition;
  titleTemplate: string;
  messageTemplate: string;
  /**
   * The `alert_templates.category` the compiler stamps on this kind's compiled
   * template (`monitorCompiler.ts`'s `buildCompiledTemplate`). Defaults to
   * `'monitor'` when absent — most kinds don't set this. A kind whose alerts
   * feed a downstream classifier (e.g. `patch_compliance` → the AI patch agent)
   * sets it to that classifier's category constant instead.
   */
  alertCategory?: string;
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
