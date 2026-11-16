/**
 * Tier-2 note writes that run without the per_step approval card in an
 * interactive chat, with or without a Wisp grant. (A helper session never
 * reaches this: PAM gates it earlier in the same function.)
 *
 *   set_device_context   appends one note (issue, quirk, follow-up, preference)
 *                        to a device's context. The write is a bare insert: it
 *                        never edits, hides or deletes an existing note and
 *                        sends nothing to the device.
 *
 * Why a note written from injected tool output is still safe to READ: notes
 * return to a model through get_device_context, the device-page system-prompt
 * preload (aiAgent.ts buildSystemPrompt) and get_alert_correlations `explain`
 * (RCA evidence). Each path sanitises the note text and fences it as untrusted
 * data. A new reader of brain_device_context must do the same.
 *
 * What the card used to stop and nothing stops now: notes are org-wide and
 * persistent, and the readers cap what they load (newest 100; RCA reads 10),
 * so a run of junk notes can push real ones out of view. The tool's rate limit
 * (aiToolRateLimits.ts) is the only bound on that today (#11986).
 *
 * `createSessionPreToolUse` (aiAgentSdk.ts) applies this with the read-only
 * path's exclusions (#3130): never on a paused session, never as an unmatched
 * step of an active plan, never for a tenant or flow tool of the same name.
 * The tool KEEPS Tier 2: the executing `ai_tool_executions` row, RBAC
 * (`devices:write`), the site-scope check in the handler, the rate limits and,
 * in a Wisp chat, the ceiling gate all still apply, and it stays a write
 * everywhere else (NOT `TIER2_READONLY_TOOLS`, so MCP hints and agent
 * allowlists are unchanged). A Tier-3 resolution never takes the path.
 *
 * Deliberately NOT here:
 *   - `resolve_device_context`: hides a note from every later session.
 *   - `manage_tags`: changes what device filters and policies match.
 *
 * CONTRACT (aiNoteWrites.contract.test.ts): every entry is a registered Tier-2
 * tool with no action multiplexing, no per-action tier entry, and no read-only
 * classification.
 *
 * Leaf module — NO imports — so the chat gate can read it cheaply.
 */
export const TIER2_NOTE_WRITE_TOOLS: ReadonlySet<string> = new Set<string>(['set_device_context']);
