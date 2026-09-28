/**
 * Absolute anchoring for the core agent mount, shared by every path gate in
 * agentAuthMiddleware (the drain allowlists, the pre-assignment allowlist in
 * ./agentAuthParked.ts and the self-managed DB context opt-out).
 *
 * Dependency-free on purpose: agentAuthParked.ts imports it, and that module's
 * unit test must not load the database or service graph.
 */

/**
 * The CORE agent mount, as absolute leading path segments.
 *
 * `index.ts` mounts `app.route('/api/v1', api)` and `api.route('/agents', agentRoutes)`,
 * so every core agent route is exactly `/api/v1/agents/<agentId>/...`.
 * `agentAuth.test.ts` pins this against those two mount lines in `index.ts`, so
 * a mount move is caught by a unit test rather than by drain mode silently
 * refusing the whole fleet.
 */
export const CORE_AGENT_MOUNT_SEGMENTS = ['api', 'v1', 'agents'] as const;

/**
 * True when `pathSegments` is EXACTLY `/api/v1/agents/<agentId>/…` with
 * `expectedLength` segments in total.
 *
 * ABSOLUTE anchoring — indexed from the FRONT, with an exact length. The
 * previous implementation indexed from the END (`at(3) === 'agents'`), which
 * matched any path whose TAIL happened to look like `agents/<id>/<action>`.
 * That was a real hole with a false comment on it: this middleware also serves
 * the extension gateway, which mounts agent routes at `<prefix>/agent/<id>/*`
 * (singular) and at `/api/v1/<routeNamespace>/agent/<id>/*`, and extension
 * route paths are copied verbatim with no validation
 * (extensions/contributionRegistry.ts). A crafted request such as
 *
 *   /api/v1/ext/acme/agent/<id>/agents/<id>/rotate-token
 *
 * has a matching tail and would have joined the drain surface. Nothing shipped
 * registers such a route today, but the AGENT supplies the tail, so it needed
 * no extension-author complicity — and the old comment claiming "no extension
 * route can join the drain surface" is exactly what would have licensed
 * someone to write one.
 *
 * Fails CLOSED in both directions: an unrecognised shape is refused during a
 * drain, and if the core mount ever moves, drain mode blocks rather than
 * admits.
 */
export function isCoreAgentPath(
  pathSegments: string[],
  agentId: string,
  expectedLength: number,
): boolean {
  if (pathSegments.length !== expectedLength) return false;
  for (const [index, segment] of CORE_AGENT_MOUNT_SEGMENTS.entries()) {
    if (pathSegments[index] !== segment) return false;
  }
  return pathSegments[CORE_AGENT_MOUNT_SEGMENTS.length] === agentId;
}

/** Index of the `<action>` segment in `/api/v1/agents/<agentId>/<action>`. */
export const CORE_AGENT_ACTION_INDEX = CORE_AGENT_MOUNT_SEGMENTS.length + 1;
