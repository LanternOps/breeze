/**
 * Tool catalog W04 (#5219) — how a step's output is stored on its ledger row.
 * Shared by the step executor (A7) and the runner's approval wake (A8), which
 * copies `action_intents.result` into the step output. A leaf module
 * (@breeze/shared only) so the runner never imports the executor's graph to
 * reuse it.
 */
import { FLOW_RUN_LIMITS, type FlowValue } from '@breeze/shared';

/** What an oversized output keeps (`{ truncated: true, preview }`). */
export const FLOW_OUTPUT_PREVIEW_BYTES = 8_192;

/** The step's output as stored: oversized ⇒ `{ truncated: true, preview: <first 8 KB of its JSON> }`. */
export function toStoredFlowOutput(value: FlowValue): { output: FlowValue; truncated: boolean } {
  const serialized = JSON.stringify(value) ?? 'null';
  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.length <= FLOW_RUN_LIMITS.maxStoredOutputBytes) return { output: value, truncated: false };
  // Cut on bytes, then drop a trailing partial UTF-8 sequence's replacement char.
  const preview = bytes.subarray(0, FLOW_OUTPUT_PREVIEW_BYTES).toString('utf8').replace(/�+$/, '');
  return { output: { truncated: true, preview }, truncated: true };
}
