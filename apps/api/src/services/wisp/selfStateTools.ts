/**
 * #10392 — Wisp's own bookkeeping writes, and when they may run without a
 * per_step approval card in chat.
 *
 * These Tier-2 tools write only Wisp's own tables under the caller's grant.
 * None of them reaches a device, a customer contact, configuration or
 * billing, and none starts a run except a `run` check-in, which admits one
 * read-only assessment under this grant when it fires. Asking the user to approve the narrowest of them adds a card and no
 * safety: the Wisp prod test saw a `remember` of the user's own sentence wait
 * 121 s on a card, and the memory page then asked for a second confirmation.
 *
 * But the card is also the human check against a prompt-injected tool result
 * writing SHARED state, so the card-less path is scoped per tool to effects
 * that stay with the grantor, only add a row, or spend this grant's own daily
 * budget on one read-only assessment:
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
 *                                  lookup, wisp/concerns.ts
 *                                  isLiveConcernRaisedByGrant). Parking one a
 *                                  person or another grant raised changes what
 *                                  others see: it keeps the card. A snooze
 *                                  writes this grant's recipient row and the
 *                                  concern status, never memory.
 *   schedule_check_in 'own_check_in'
 *                                  a check-in on this grant's own thread (the
 *                                  handler takes the thread from the grant,
 *                                  never from the model). `notify` tells only
 *                                  the grantor and runs nothing. `run` (W07
 *                                  #11496) starts ONE assessment when it
 *                                  fires. The assessment applies nothing
 *                                  itself; like any assessment it may
 *                                  propose up to three actions
 *                                  (assessmentFinalizer.ts), each waiting
 *                                  on an approval card (spec 2026-11-06
 *                                  §6.2: "effects raise cards as they do
 *                                  today"). It used to keep the card for that
 *                                  spend. It no longer does, by owner
 *                                  decision: each run is one capped
 *                                  assessment, a thread holds at most five
 *                                  pending check-ins, and total spend is
 *                                  capped by the grant's daily budget and
 *                                  the assessment admission caps. The cost
 *                                  of that: an injected instruction can use
 *                                  up the day's budget, which leaves none
 *                                  for the grant's other background model
 *                                  work until 00:00 UTC. The instruction is
 *                                  unreviewed model text and is fenced as
 *                                  such where a run reads it
 *                                  (assessmentPrompt.ts). A mode that is
 *                                  neither is refused by input validation
 *                                  first; this arm keeps the card as
 *                                  defense in depth.
 *   cancel_check_in 'own_thread'   only this grant's own check-ins: the
 *                                  service's UPDATE is keyed on the grant, so
 *                                  another grant's id cancels nothing. No
 *                                  gate-time lookup is needed for that.
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
 *   - `resolve_concern`: `resolveConcern` always remembers the outcome as an
 *     org- or partner-owned `concern_outcome` memory block — shared standing
 *     context, the same reason org/partner `remember` keeps its card — and it
 *     closes the concern for every recipient.
 *   - `create_watch`: every watch is a RECURRING assessment that spends grant
 *     budget on a cadence with no end — the same reason an auto-admit
 *     `launch_specialist` sweep keeps its card under per_step (#10144). A run
 *     check-in fires once.
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
export type WispSelfStateScope = 'own_memory' | 'adds_row' | 'own_concern' | 'own_thread' | 'own_check_in';

export const WISP_SELF_STATE_TOOLS: ReadonlyMap<string, WispSelfStateScope> = new Map<string, WispSelfStateScope>([
  ['remember', 'own_memory'],
  ['raise_concern', 'adds_row'],
  ['link_entity', 'adds_row'],
  ['snooze_concern', 'own_concern'],
  ['schedule_check_in', 'own_check_in'],
  ['cancel_check_in', 'own_thread'],
]);
