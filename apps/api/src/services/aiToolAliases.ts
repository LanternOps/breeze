/**
 * Deprecated AI tool-name aliases — dispatch only, never advertised.
 *
 * When a tool is renamed, external MCP clients that cached or hardcoded the old
 * name would otherwise get `Unknown tool` until they re-run `tools/list`. An
 * alias here keeps those calls working for one release.
 *
 * DISPATCH ONLY, and deliberately so. An alias is NOT registered in the
 * `aiTools` map and NOT emitted by `tools/list`, because `tools/list` is what
 * the model chooses from and the tool NAME is what wins that choice. #5362 is
 * exactly that failure: `get_fleet_status` (the deployment-invite funnel) was
 * picked for a "Show fleet status" prompt and answered "your fleet is empty"
 * from funnel zeros on a 51-device tenant. Re-advertising the old name under an
 * alias would reintroduce the bug the rename exists to fix.
 *
 * Resolution happens once, at the MCP `tools/call` entry point, BEFORE every
 * name-keyed gate (tier lookup, guardrails, MCP approval gate, production
 * execute allowlist, RBAC permission check, schema validation, dispatch). So an
 * aliased call is authorized as the canonical tool and can never pick up weaker
 * gates than the real name — there is no second set of entries to keep in sync.
 *
 * Removing an entry is the expected end state: drop it one release after the
 * rename ships, once clients have re-listed.
 */

/**
 * Old name → canonical name.
 *
 * A `Map`, not an object literal: the lookup key is attacker-controlled
 * (`params.name` off the wire), and an object lookup for `__proto__` /
 * `constructor` returns an inherited value, so `resolve` could hand a
 * non-string back to the dispatch path. A `Map` only ever matches own entries.
 */
export const DEPRECATED_TOOL_ALIASES: ReadonlyMap<string, string> = new Map([
  // #5362 — renamed in v0.112. Remove one release after v0.112 ships.
  ['get_fleet_status', 'get_invite_funnel'],
]);

/**
 * Map a possibly-deprecated tool name to its canonical name. Unknown names pass
 * through untouched so the caller's own "unknown tool" handling still fires.
 */
export function resolveDeprecatedToolAlias(toolName: string): string {
  return DEPRECATED_TOOL_ALIASES.get(toolName) ?? toolName;
}

/** True when `toolName` is a deprecated alias rather than a canonical name. */
export function isDeprecatedToolAlias(toolName: string): boolean {
  return DEPRECATED_TOOL_ALIASES.has(toolName);
}
