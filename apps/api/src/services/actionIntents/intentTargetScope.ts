/**
 * P2-2 (Task A3, #4189) — the ONE resolver every run-derived reader of an
 * action intent's target device goes through.
 *
 * Before P2-2 an agent-originated intent's target device was, everywhere,
 * `ai_agent_runs.device_id`: creation re-verified the guardrail with it, the
 * approver fan-out unioned it into the target scope, and all four
 * release/decide-time readers (actorContext, agentReleaseAuthority,
 * policyDecide, isAgentIntentDecideAuthorized) re-derived it from the run
 * row. That is exactly wrong for a scheduled SWEEP: the sweep run is
 * DEVICE-LESS (one run walks a whole fleet) and must still be able to mint an
 * intent bound to ONE device — and `checkAgentGuardrails` denies every
 * mutating call whose `policy.deviceId` is null (aiGuardrails.ts: "the run is
 * not device-bound"), so a device-less run could not propose anything at all.
 *
 * `action_intents.scope_kind` / `scope_device_id` (Task A1) carry that
 * explicit binding. This module is the single place that decides which device
 * an intent actually targets, so no reader can drift back to the run's own
 * device once a scope exists:
 *
 *   - no scope  -> `{ kind: 'run', deviceId: run.deviceId }` — byte-identical
 *     behavior to before this module existed, including a null device.
 *   - scope set -> `{ kind: 'scope', deviceId }` — the run's device is never
 *     consulted, even when the run has one.
 *   - scope declared but `scope_device_id` NULL -> `{ kind: 'tombstone' }`,
 *     the fail-closed state. The column tombstones (non-null -> NULL, the ONLY
 *     transition the immutability trigger permits) on a device DELETE via the
 *     FK's `ON DELETE SET NULL`, and on a device moveOrg via that
 *     transaction's explicit detach — see db/schema/actionIntents.ts's
 *     comment block on the two columns.
 *
 * Deliberately PURE — no DB, no imports from `intentService` (which imports
 * the approver/target machinery that would cycle back here). Callers that need
 * the device's CURRENT org/site do the read themselves; the release-time
 * contract they must implement is:
 *
 *   a tombstone, a scoped device that no longer exists, OR a scoped device
 *   whose CURRENT `org_id` differs from the intent's org are ALL treated
 *   identically — `agent_scope_lost`, intent -> failed / decide -> false.
 *
 * The org half of that is the backstop for a device org-move that lands
 * through the DB-side cascade rather than the HTTP moveOrg route (which does
 * detach the scope): the row would still carry a live `scope_device_id`
 * pointing at a device that now belongs to someone else.
 */

/** What an intent actually targets, once its scope columns are consulted. */
export type IntentTargetDevice =
  /** No explicit scope: the run's own device (which may legitimately be null). */
  | { kind: 'run'; deviceId: string | null }
  /** Explicit device scope, device still linked. */
  | { kind: 'scope'; deviceId: string }
  /** `scope_kind='device'` but `scope_device_id IS NULL` — fail closed. */
  | { kind: 'tombstone' };

/**
 * The scope projection every caller must select alongside the intent row.
 * All three fields are nullable in the DB. `scopeKind` is CHECK-constrained
 * to 'device' | 'ticket' | NULL (P2-2 + P2-4's action_intents_scope_kind_chk)
 * — but `resolveIntentTargetDevice` below is PURELY about the intent's
 * target DEVICE, so 'ticket' is deliberately handled the same as no
 * explicit scope at all there (falls through to the run's own device, which
 * may be null): a ticket-triage intent has no device target by
 * construction. `resolveIntentTargetTicket` (P2-4 Task A3, #4191) is the
 * mirror-image resolver for the ticket target — same shape, not an
 * extension of the device one, since a device-scoped or unscoped intent has
 * no ticket target either.
 */
export interface IntentScopeColumns {
  scopeKind: 'device' | 'ticket' | null;
  scopeDeviceId: string | null;
  scopeTicketId: string | null;
}

/**
 * Resolve the intent's target device. `run` may be null (a caller that could
 * not load the run) — a scoped intent still resolves, which is the point.
 */
export function resolveIntentTargetDevice(
  intent: IntentScopeColumns,
  run: { deviceId: string | null } | null,
): IntentTargetDevice {
  if (intent.scopeKind === 'device') {
    return intent.scopeDeviceId === null || intent.scopeDeviceId === undefined
      ? { kind: 'tombstone' }
      : { kind: 'scope', deviceId: intent.scopeDeviceId };
  }
  return { kind: 'run', deviceId: run?.deviceId ?? null };
}

/**
 * The device id to feed a guardrail policy / device lookup / exposure
 * reservation. A tombstone collapses to `null` — which every mutating
 * guardrail check already denies ("the run is not device-bound"), so a caller
 * that forgets to branch on `kind === 'tombstone'` still fails closed rather
 * than silently widening to the run's device.
 */
export function effectiveTargetDeviceId(target: IntentTargetDevice): string | null {
  return target.kind === 'tombstone' ? null : target.deviceId;
}

/**
 * What an intent actually targets on the TICKET axis (P2-4 Task A3, #4191).
 * Unlike `IntentTargetDevice`, there is no `'run'` fallback variant — a run
 * has no run-level "own ticket" equivalent to `run.deviceId` that a reader
 * should fall back to, so an intent with no ticket scope simply targets no
 * ticket (`'none'`).
 */
export type IntentTargetTicket =
  /** Explicit ticket scope, ticket still linked. */
  | { kind: 'scope'; ticketId: string }
  /** `scope_kind='ticket'` but `scope_ticket_id IS NULL` — fail closed,
   *  same tombstone shape as the device resolver (produced by the
   *  `manage_tickets:move_org` executor's detach — see that file). */
  | { kind: 'tombstone' }
  /** No ticket scope at all: `scopeKind` is `null` or `'device'`. */
  | { kind: 'none' };

/**
 * Resolve the intent's target ticket. Pure and synchronous, same contract as
 * `resolveIntentTargetDevice` — no DB, no run fallback (see the type's doc
 * comment above for why there is nothing to fall back to).
 */
export function resolveIntentTargetTicket(intent: IntentScopeColumns): IntentTargetTicket {
  if (intent.scopeKind !== 'ticket') {
    return { kind: 'none' };
  }
  return intent.scopeTicketId === null || intent.scopeTicketId === undefined
    ? { kind: 'tombstone' }
    : { kind: 'scope', ticketId: intent.scopeTicketId };
}

/**
 * The scoped device is gone (tombstoned, deleted, or moved to another org)
 * and the intent can never be released. Terminal, never retried: the release
 * worker CASes `executing -> failed` on this code exactly as it does for
 * `agent_policy_denied` (it is NOT in the pausable `kill_switch_engaged`
 * class — the device is not coming back).
 */
export class IntentScopeLostError extends Error {
  readonly code = 'agent_scope_lost';
  constructor(message = 'agent_scope_lost: the intent\'s scoped target device is no longer available') {
    super(message);
    this.name = 'IntentScopeLostError';
  }
}

/**
 * The proposed arguments name a device other than the one the intent is
 * scoped to. Thrown by `assertArgsMatchScope`; `intentService` maps it onto
 * `ActionIntentError(..., 'scope_argument_mismatch')` at creation time (this
 * module must not import `intentService` — that would cycle).
 */
export class IntentScopeArgumentMismatchError extends Error {
  readonly code = 'scope_argument_mismatch';
  constructor(message: string) {
    super(message);
    this.name = 'IntentScopeArgumentMismatchError';
  }
}

/**
 * Creation-time consistency gate: a scoped intent's arguments must not reach
 * past the device the scope pins it to.
 *
 *   - `deviceId`, when present, must EQUAL the scope device.
 *   - `deviceIds`, when present, must be EXACTLY `[scope]` — one member, the
 *     scope device. A superset is what a compromised sweep runner would send.
 *   - a tool carrying NEITHER device argument passes. `remediate_vulnerability`
 *     is the motivating case: its targets are `deviceVulnerabilityIds`, whose
 *     per-finding device assertion is a DB read and therefore Task 5's job,
 *     not this pure function's.
 *
 * Fail-closed on shape: a present-but-non-string `deviceId`, or a `deviceIds`
 * that is not an array of exactly the scope device, throws rather than being
 * waved through as "malformed, so harmless". Null/undefined values count as
 * absent (the tool schema, not this gate, decides whether that is legal).
 *
 * BOUNDARY — read this before assuming a scoped intent cannot name another
 * device. This gate knows exactly TWO argument names, `deviceId` and
 * `deviceIds`. A tool whose device argument is named anything else PASSES it
 * unexamined, including every tool whose targets are indirect (a group, a
 * filter, a saved deployment) or expressed through an id that only RESOLVES
 * to a device via a DB read. The registry's own per-tool `deviceArgs`
 * declaration (`services/aiTools*.ts`, consumed by
 * `intentApprovers.DEVICE_COMPLETE_TARGET_TOOLS`) is the authority on which
 * argument names a given tool actually targets devices through, and it is
 * deliberately NOT consulted here: this function is pure and synchronous,
 * while a complete check for those tools needs I/O.
 *
 * Tool-specific containment is therefore a per-tool obligation layered on top
 * of this one, not a substitute for it. `remediate_vulnerability` is the
 * worked example and the pattern to copy: it carries only
 * `deviceVulnerabilityIds`, so it passes this gate, and its per-finding
 * "every cited finding belongs to the scope device" assertion — which must
 * read the findings to know — ships in Task 5.
 */
export function assertArgsMatchScope(
  toolName: string,
  args: Record<string, unknown>,
  scopeDeviceId: string,
): void {
  const fail = (detail: string): never => {
    throw new IntentScopeArgumentMismatchError(
      `scope_argument_mismatch: tool "${toolName}" arguments ${detail} but the intent is scoped to device ${scopeDeviceId}`,
    );
  };

  const deviceId = args.deviceId;
  if (deviceId !== undefined && deviceId !== null) {
    if (typeof deviceId !== 'string' || deviceId !== scopeDeviceId) {
      fail(`name deviceId ${JSON.stringify(deviceId)}`);
    }
  }

  const deviceIds = args.deviceIds;
  if (deviceIds !== undefined && deviceIds !== null) {
    if (!Array.isArray(deviceIds) || deviceIds.length !== 1 || deviceIds[0] !== scopeDeviceId) {
      fail(`name deviceIds ${JSON.stringify(deviceIds)}`);
    }
  }
}

/**
 * Creation-time consistency gate for the ticket axis (I2, final review
 * #4191) — mirrors `assertArgsMatchScope` exactly, including reusing
 * `IntentScopeArgumentMismatchError` (same error class/code:
 * `scope_argument_mismatch`) so `intentService.ts`'s existing catch/rethrow
 * onto `ActionIntentError(..., 'scope_argument_mismatch')` covers both axes
 * unchanged.
 *
 * Before this gate, a scoped intent's arguments could name a DIFFERENT
 * ticket than the one `scope_ticket_id` pins it to — release-time guardrail
 * re-runs and approver fan-out narrow to the scope ticket
 * (`resolveIntentTargetTicket`), so an argument mismatch would let the tool
 * act on a ticket that never went through that narrowing.
 *
 * Only one argument name is known here, `ticketId` (the ticketing tools have
 * no `ticketIds` plural — every ticket-scoped tool call names exactly one
 * ticket; see `aiToolsTicketing.ts`). A tool call carrying NO `ticketId` at
 * all passes: the scope itself is the binding for those calls (e.g.
 * `move_org`'s `ticketId` argument IS present and checked, but a
 * hypothetical scoped tool with no ticket argument has nothing to check
 * against and is not this gate's problem, same boundary as the device
 * version's doc comment above).
 */
export function assertArgsMatchTicketScope(
  toolName: string,
  args: Record<string, unknown>,
  scopeTicketId: string,
): void {
  const ticketId = args.ticketId;
  if (ticketId === undefined || ticketId === null) return;
  if (typeof ticketId !== 'string' || ticketId !== scopeTicketId) {
    throw new IntentScopeArgumentMismatchError(
      `scope_argument_mismatch: tool "${toolName}" arguments name ticketId ${JSON.stringify(ticketId)} but the intent is scoped to ticket ${scopeTicketId}`,
    );
  }
}
