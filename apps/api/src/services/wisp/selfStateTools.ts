/**
 * #10392 — Wisp's own bookkeeping writes.
 *
 * These Tier-2 tools write only Wisp's own state under the caller's grant:
 * memory blocks (`remember` — stored unconfirmed; the owner confirms or
 * retracts on the memory page), concerns (`raise_concern`, `snooze_concern`,
 * `resolve_concern`) and thread links (`link_entity`). None of them reaches a
 * device, a customer contact, configuration, billing, or a run, so asking the
 * user to approve each one adds a card and no safety: the Wisp prod test saw a
 * `remember` of the user's own sentence wait 121 s on a per_step card, and the
 * memory page then asked them to confirm it a second time.
 *
 * In a chat session under a live Wisp grant, `createSessionPreToolUse`
 * (aiAgentSdk.ts) runs these without the per_step card, with the same
 * exclusions as the #3130 read-only fast path (never on a paused session,
 * never as an unmatched step of an active plan). They KEEP Tier 2: the
 * executing `ai_tool_executions` row, the rate limits in aiToolRateLimits.ts,
 * the ceiling gate, RBAC, and the write classification everywhere else (they
 * are deliberately NOT in `TIER2_READONLY_TOOLS`, so MCP still marks them
 * non-read-only and agent runs still need them on the allowlist). A Tier-3
 * resolution never takes the path.
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
export const WISP_SELF_STATE_TOOLS: ReadonlySet<string> = new Set<string>([
  'remember',
  'raise_concern',
  'snooze_concern',
  'resolve_concern',
  'link_entity',
]);
