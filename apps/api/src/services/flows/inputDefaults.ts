/**
 * Tool catalog W04 (#5219), Task A9 — the inputs of a run nobody typed
 * (schedule and event runs): every declared input is null (spec §6.2, the
 * same default `coerceFlowInputs` gives an absent optional input). A leaf
 * (@breeze/shared types only) so the triggers never import runService's
 * graph to reuse it.
 */
import type { FlowDocumentV1, FlowValue } from '@breeze/shared';

export function nullFlowInputs(decls: FlowDocumentV1['inputs'] | unknown): Record<string, FlowValue> {
  const out: Record<string, FlowValue> = {};
  if (!Array.isArray(decls)) return out;
  for (const decl of decls) {
    if (decl && typeof decl === 'object' && typeof (decl as { name?: unknown }).name === 'string') out[(decl as { name: string }).name] = null;
  }
  return out;
}
