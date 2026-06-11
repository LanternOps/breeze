/**
 * Server-side derivation of `approval_requests.is_recursive`.
 *
 * An approval is "recursive" when the requesting OAuth client is the
 * target user's own mobile app — the same phone that will receive the
 * push notification is also the originator. This is the self-approval
 * loop the mobile UI gates behind a 5-second hold-to-confirm after
 * biometric (an explicit deliberate moment to acknowledge "you are
 * approving your own action").
 *
 * Replaces the mobile client's brittle label-prefix heuristic
 * (`requestingClientLabel.startsWith('Breeze Mobile')`) with a
 * server-issued boolean. The mobile screen now reads `isRecursive`
 * directly from the API payload.
 *
 * NOTE on coverage today: the AI agent SDK path (the only insert site
 * that runs in real user traffic) does not yet plumb the OAuth client
 * id through to the approval row — `requestingClientId` is null. Until
 * the mobile-MCP step-up path lands, every derivation returns FALSE.
 * The plumbing is in place so the flip is a one-line change.
 */

const BREEZE_MOBILE_OAUTH_CLIENT_NAMES: ReadonlySet<string> = new Set([
  // The DCR-registered client_name that the mobile app advertises when it
  // becomes a step-up MCP client. Match by name (not id) because DCR mints
  // per-install client_ids and we want all installs of the mobile app to
  // count, not a specific row.
  'Breeze Mobile',
  'breeze-mobile',
]);

export interface DeriveIsRecursiveInput {
  /**
   * The OAuth client_id stored on the approval row (and looked up via
   * resolveClientName). Null/undefined when the request did not originate
   * from an OAuth-registered client (current AI-agent path, dev/seed,
   * test trigger).
   */
  readonly requestingClientId: string | null | undefined;

  /**
   * The user the approval is being addressed to (the row's user_id).
   * Required so that an OAuth client acting on behalf of user A can NOT
   * be flagged recursive against user B's pending approval.
   */
  readonly targetUserId: string;

  /**
   * The user that the requesting OAuth grant authenticates as, when the
   * caller already has it on hand. Lets us short-circuit the recursion
   * check without resolving the grant. Pass null/undefined to indicate
   * "unknown".
   */
  readonly requestingUserId?: string | null;

  /**
   * Resolves an OAuth client_id to its registered client_name. Returns
   * null when the id is unknown (e.g. soft-deleted clients).
   *
   * Injectable so callers can use a system-scoped DB lookup, an in-memory
   * test fake, or the real RLS-bypassing system context.
   */
  readonly resolveClientName?: (clientId: string) => Promise<string | null>;
}

/**
 * Pure derivation. Returns true iff:
 *   1. There is a requesting OAuth client id, AND
 *   2. The resolved client_name matches the mobile app's DCR registration, AND
 *   3. The requesting user (when known) matches the approval's target user.
 *
 * Any unknown / null input → false (fail closed; over-gating with the 5s
 * hold is the wrong default UX).
 */
export async function deriveIsRecursive(input: DeriveIsRecursiveInput): Promise<boolean> {
  const { requestingClientId, targetUserId, requestingUserId, resolveClientName } = input;

  if (!requestingClientId) return false;
  if (!resolveClientName) return false;

  // If the caller knows who the OAuth grant authenticates as and it isn't
  // the same person as the approval target, this can't possibly be a
  // self-loop.
  if (requestingUserId != null && requestingUserId !== targetUserId) return false;

  let name: string | null;
  try {
    name = await resolveClientName(requestingClientId);
  } catch {
    return false;
  }
  if (!name) return false;

  return BREEZE_MOBILE_OAUTH_CLIENT_NAMES.has(name);
}
