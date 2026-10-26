/**
 * Tool Catalog W05 (#5220), Decision 12 — whether an action intent is a flow
 * built-in step's. A leaf (@breeze/shared only) so the release revalidation
 * and the release worker can branch on it without loading the built-ins.
 * `createActionIntent` accepts a built-in name only from a flow principal's
 * own run with `flowRun.builtin`, and built-in names are disjoint from core
 * tool names (builtinNames.contract.test.ts), so the name decides.
 */
import { isFlowBuiltin } from '@breeze/shared';

export function isFlowBuiltinIntent(intent: { actionName: string; source: string; requestingFlowRunId: string | null }): boolean {
  return intent.source === 'flow' && !!intent.requestingFlowRunId && isFlowBuiltin(intent.actionName);
}
