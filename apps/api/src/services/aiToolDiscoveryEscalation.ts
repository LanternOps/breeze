/**
 * Pure "is this call Tier 3" predicate for the discovery report (#12421).
 *
 * Walks exactly the tier chain `checkGuardrails` walks (aiGuardrails.ts), with
 * no guardrail context and no DB: it imports the same maps and helpers rather
 * than copying them, so a table edit cannot make the two disagree. The pin
 * test compares it with `checkGuardrails(...).tier === 3` over every
 * (tool, action) pair.
 *
 * Context-dependent branches are not modelled, and none of them can produce
 * tier 3: the chat-session and Wisp lowerings only ever yield tier 2, and a
 * proposal-backed run_script with no loaded proposal is tier 4 in
 * checkGuardrails but is reported here by its base tier (3), which is what
 * the call becomes once the proposal context loads.
 */
import { requestsLiveDeviceRead } from './aiLiveDeviceReads';
import {
  BLOCKED_TOOLS,
  TIER1_ACTIONS,
  TIER2_ACTIONS,
  TIER3_ACTIONS,
  isInputAwareTier3,
  resolveActionForTool,
} from './aiGuardrails';
import { getToolTier } from './aiTools';

export function isEscalatedCall(toolName: string, input: Record<string, unknown>): boolean {
  if (BLOCKED_TOOLS.has(toolName)) return false;
  const baseTier = getToolTier(toolName);
  if (baseTier === undefined) return false;

  const action = resolveActionForTool(toolName, input);
  if (action && TIER1_ACTIONS[toolName]?.includes(action)) return false;
  if (isInputAwareTier3(toolName, action, input)) return true;
  if (action && TIER3_ACTIONS[toolName]?.includes(action)) return true;
  if (action && TIER2_ACTIONS[toolName]?.includes(action)) return false;
  if (requestsLiveDeviceRead(toolName, input)) return false;
  return baseTier === 3;
}
