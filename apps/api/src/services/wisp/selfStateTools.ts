/**
 * #10392 — Wisp's own bookkeeping writes, and when they may run without a
 * per_step approval card in chat.
 *
 * These Tier-2 tools write only Wisp's own tables under the caller's grant.
 * None of them reaches a device, a customer contact, configuration, billing or
 * a run. Asking the user to approve the narrowest of them adds a card and no
 * safety: the Wisp prod test saw a `remember` of the user's own sentence wait
 * 121 s on a card, and the memory page then asked for a second confirmation.
 *
 * But the card is also the human check against a prompt-injected tool result
 * writing SHARED state, so the card-less path is scoped per tool to effects
 * that stay with the grantor or only add a row:
 *
 *   remember        'own_memory'   only `ownerKind: 'user'` — the grantor's own
 *                                  memory (the handler pins the owner to the
 *                                  grantor; the broker supersedes only that
 *                                  owner's UNCONFIRMED blocks). Org- and
 *                                  partner-owned memory is standing context for
 *                                  every later session there: it keeps the card.
 *   raise_concern   'adds_row'     inserts a concern or reports the live one
 *                                  (ON CONFLICT DO NOTHING): never overwrites,
 *                                  closes or hides an existing concern.
 *   link_entity     'adds_row'     a link on this grant's own thread.
 *   snooze_concern  'own_concern'  only a concern THIS grant raised (gate-time
 *   resolve_concern 'own_concern'  lookup, wisp/concerns.ts
 *                                  isLiveConcernRaisedByGrant). Parking or
 *                                  closing one a person or another grant raised
 *                                  changes what others see: it keeps the card.
 *
 * `createSessionPreToolUse` (aiAgentSdk.ts) applies this only to a call that
 * passed the live Wisp ceiling gate this turn, with the #3130 read-only path's
 * exclusions (never on a paused session, never as an unmatched step of an
 * active plan). The tools KEEP Tier 2: the executing `ai_tool_executions` row,
 * the rate limits (aiToolRateLimits.ts), the ceiling gate, RBAC, and the write
 * classification everywhere else (NOT `TIER2_READONLY_TOOLS`, so MCP hints and
 * agent allowlists are unchanged). A Tier-3 resolution never takes the path.
 *
 * Deliberately NOT here:
 *   - `create_watch`: every watch is a recurring assessment that spends grant
 *     budget — the same reason an auto-admit `launch_specialist` sweep keeps
 *     its card under per_step (#10144).
 *   - `confirm_memory` / `retract_memory`: human-only, Tier 3.
 *
 * CONTRACT (wisp/selfStateTools.contract.test.ts): every entry is a
 * registered Tier-2 tool in the `ai` domain with no device arguments, no
 * action multiplexing, no Tier-1/2/3 action table entry, and is not on a
 * read-only allowlist.
 *
 * Leaf module — NO imports — so the chat gate can read it without loading the
 * Wisp graph for an ordinary session.
 */
export type WispSelfStateScope = 'own_memory' | 'adds_row' | 'own_concern';

export const WISP_SELF_STATE_TOOLS: ReadonlyMap<string, WispSelfStateScope> = new Map<string, WispSelfStateScope>([
  ['remember', 'own_memory'],
  ['raise_concern', 'adds_row'],
  ['link_entity', 'adds_row'],
  ['snooze_concern', 'own_concern'],
  ['resolve_concern', 'own_concern'],
]);
