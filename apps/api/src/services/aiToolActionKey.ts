/**
 * Pure, import-free reads of an AI tool call's input, shared by the guardrails
 * (aiGuardrails.ts re-exports both) and the approval impact line
 * (actionIntents/intentService.ts). A leaf on purpose: aiGuardrails.ts pulls a
 * large import graph, and intentService's unit suites mock that module with
 * only the two functions they drive, so a helper read through it there would
 * be undefined at call time (#12774).
 */

// Sub-operation discriminator key per tool. Most action-multiplexed tools
// carry their sub-operation in `action`; execute_command multiplexes on
// `commandType` (#3088) — that string selects the agent-side command handler,
// so it is a real dispatch discriminator, not a heuristic over command text.
// The TIER1/2/3_ACTIONS tables are indexed by the value found under this key.
// Exported for the tier-parity contract tests (aiGuardrailsTierParity.shared.ts).
export const TOOL_ACTION_INPUT_KEYS: Record<string, string> = {
  execute_command: 'commandType',
  // Wisp W07: launch_specialist is multiplexed on the specialist KIND.
  launch_specialist: 'kind',
};

/**
 * The sub-operation discriminator for a tool call, resolved EXACTLY the way
 * `checkGuardrails` and `checkAgentGuardrails` each used to do inline (two
 * byte-identical copies, now one). `TOOL_ACTION_INPUT_KEYS` overrides the
 * default `action` key for a multiplexer keyed on something else
 * (`execute_command`'s `commandType`, #3088). A non-string value at that key
 * resolves to `undefined`, not a coerced string — callers fall back to
 * whatever "no action" means for them (checkGuardrails: the tool's base
 * tier; checkAgentGuardrails: a hard deny on a multiplexed tool;
 * policyDecide.ts: no `tool:action` key, so a bare-tool registry lookup).
 *
 * Exported so `policyDecide.ts`'s canonical-key derivation reuses this
 * instead of a third inline copy (wave 5 Part B, #3827).
 */
export function resolveActionForTool(toolName: string, input: Record<string, unknown>): string | undefined {
  const actionKey = TOOL_ACTION_INPUT_KEYS[toolName] ?? 'action';
  const actionValue = input[actionKey];
  return typeof actionValue === 'string' ? actionValue : undefined;
}

/**
 * `manage_tickets update_fields` keys that change who receives requester email
 * (W02, #6756). The Tier-3 escalation (isInputAwareTier3) and the approval
 * impact line both read this list, so they cannot disagree on which edits
 * repoint the requester.
 */
export const TICKET_REQUESTER_FIELD_KEYS = ['submittedBy', 'submitterName', 'submitterEmail'] as const;
