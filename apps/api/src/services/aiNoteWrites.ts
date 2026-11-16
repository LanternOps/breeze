/**
 * Tier-2 note writes that run without the per_step approval card in any chat,
 * with or without a Wisp grant.
 *
 *   set_device_context   appends one note (issue, quirk, follow-up, preference)
 *                        to a device's context. It never edits, hides or
 *                        deletes an existing note and sends nothing to the
 *                        device. Notes come back to a model only through
 *                        get_device_context, which sanitises every field and
 *                        wraps the set as untrusted data, so a note written
 *                        from injected tool output is read as data, not as an
 *                        instruction.
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
