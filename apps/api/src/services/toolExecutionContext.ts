import type { ReleaseDecision } from './scriptProposals/approvalMethod';
import type { scripts } from '../db/schema';
import type { RunScriptSnapshot } from './actionIntents/runScriptSnapshot';
import type { TenantVariableScope } from './tenantVariableResolution';
import type { TopologyRequestContext } from './topology/access';
import type { VerifiedTopologyDiagnostic } from './topology/aiDiagnosticEffect';

/**
 * One `run_script` release, resolved once and verified against the approval's
 * pinned digest.
 *
 * THREE SIBLINGS, ONE OBSERVATION. All three come from the same
 * `buildRunScriptSnapshot` call, and they are kept flat rather than nested for
 * the reason `runScriptSnapshot.ts`'s header spells out: `snapshot` is pure
 * digest material, and `scope` holds DECRYPTED tenant-variable plaintext.
 * Hanging the scope off the snapshot would make one stray
 * `JSON.stringify(snapshot)` in a log or audit path a leak; as siblings, the
 * leak is structurally absent rather than merely avoided.
 *
 * They also travel together or not at all — a handler given the row but not
 * the scope would silently re-resolve variables the digest already pinned —
 * which is why this is one grouped payload and not three optional fields on
 * `ToolExecutionContext`.
 */
export type VerifiedRunScript = {
  /** What the effect digest was computed over. Never carries a variable VALUE. */
  snapshot: RunScriptSnapshot;
  /**
   * The whole `scripts` row that observation read. Dispatch needs columns the
   * digest does not pin (`osTypes`, `partnerId`, the raw `parameters` jsonb),
   * and re-reading for them would reopen the window the digest closes.
   *
   * Read under a SYSTEM context with no org filter, so a handler consuming it
   * still owes the caller's own authorization checks — see `run_script` in
   * `aiToolsScripts.ts`, which re-applies the org filter its skipped query
   * carried.
   */
  scriptRow: typeof scripts.$inferSelect;
  /** The exact resolved scope the digest's variable references were pinned from. */
  scope: TenantVariableScope;
};

/**
 * Material a release path has ALREADY resolved and verified against the
 * approval's pinned effect digest, handed to the tool handler so it does not
 * re-query — a second read reopens the check/use window the digest exists to
 * close (#3409 PR4c-1).
 *
 * DELIBERATELY NARROW AND DELIBERATELY EXPLICIT. Two "simplifications" look
 * tempting from the handler side; both are wrong:
 *
 *   - NOT on `AuthContext`. That is a CALLER IDENTITY — who is asking, and what
 *     they may reach. It is built by auth middleware, is the same object for
 *     every tool a caller invokes, and is read by tenancy gates. Verified
 *     release material is a per-invocation EXECUTION INPUT produced by the
 *     release path; hanging it off the identity would make every downstream
 *     tenancy check read from an object that a release path can extend.
 *
 *   - NOT inside `args`. `args` is the digest's OWN input: it is the immutable
 *     `action_intents.arguments` column the approver approved and the digest was
 *     computed over. Smuggling the verification RESULT back into the digest's
 *     INPUT would make the pinned material self-referential, and any handler
 *     that echoes or re-serializes its input would start emitting it.
 *
 * So it travels as its own explicit parameter: greppable, typed, and incapable
 * of silently failing to propagate the way an ambient/AsyncLocalStorage store
 * can (the inline release path verifies in `aiAgentSdk.ts` and executes later
 * from `aiAgentSdkTools.ts`'s handler factory — not one async scope).
 *
 * HOST-INTERNAL. `executeTool` passes this to CORE handlers only; extension
 * handlers are invoked with exactly two arguments. See `executeTool`.
 */
export type ToolExecutionContext = {
  verifiedRunScript?: VerifiedRunScript;
  /**
   * The `action_intents` row whose approved release is executing this call —
   * set by BOTH release paths (jobs/intentReleaseWorker.ts, and the inline
   * chat release in services/aiAgentSdk.ts, whose preToolUse gate already
   * returns the id it won the executing-CAS on) and by nothing else. Absent
   * for every direct chat/MCP/script-builder call, which is what makes it a
   * usable discriminator: a handler that must not run outside an approved
   * release fails closed on `undefined` rather than trusting a
   * caller-supplied id.
   *
   * It belongs here for the reason the header gives above — it is a
   * per-invocation EXECUTION INPUT produced by the release path, not a caller
   * identity (AuthContext) and not part of the approved `arguments` the
   * digest is computed over. `manage_ai_agents:authorize_supervised_key`
   * (P2-5, #4192) is the first consumer: it stamps
   * `ai_agent_graduation.promoted_intent_id` with the approval that granted
   * the key, and re-asserts that intent's own immutable `org_id` before
   * writing anything.
   */
  actionIntentId?: string;
  /**
   * Device ids frozen at admission for this run (spec §8 data minimisation).
   * A device-scoped tool that can span MANY devices — `export_dataset` today —
   * must refuse any id outside this set. The central `enforceDeviceArgs` gate
   * answers "may this CALLER reach this device"; this answers the different
   * question "is this device in the set a human admitted THIS run for", and
   * one does not imply the other: an agent principal can reach the whole org.
   *
   * ABSENT means "no run frame", not "no restriction" — a direct chat/MCP call
   * has no frozen set, and is bounded by the caller gate alone.
   *
   * Only the CONSTRAINT lives here. The run id and org are read from the auth
   * principal (`auth.principal.runId`, `auth.orgId`) — see reconciliation R4.
   */
  runTargets?: readonly string[];
  /** Bytes this run may still stage into artifacts. */
  stagedBytesRemaining?: number;
  /**
   * The released intent's decision record — set by the SAME two release
   * paths that set `actionIntentId`, from the intent row they already hold,
   * and by nothing else (#5645). `run_script`'s proposal branch derives the
   * execution row's `approval_method` (spec §4.1) from it via
   * `approvalMethodForRelease`; a handler that finds it absent has no
   * release to attribute the run to and must not invent a method.
   *
   * Passed alongside `actionIntentId` unconditionally for the reason that
   * field is: structurally unobservable to every handler that does not read
   * it, and a tool-name gate would have to be edited by the next consumer.
   */
  releaseDecision?: ReleaseDecision;
  /**
   * #4177 (W04): set ONLY by jobs/intentReleaseWorker.ts, and only when it
   * releases an agent-originated intent whose action creates a row OWNED by
   * a real user (`USER_OWNED_RELEASE_ACTIONS` — `manage_tickets:
   * log_time_entry`, whose `time_entries.user_id` is a users FK, plus the
   * three `services/aiToolsFleet.ts` writers added by #6200:
   * `manage_deployments:create`, `manage_patches:install` and
   * `manage_patches:rollback`, and the three `manage_alerts` mutations
   * added by #6907: `acknowledge`, `resolve` and `suppress`). The worker
   * swaps the rebuilt agent auth for the APPROVER's own AuthContext
   * (`action_intents.decided_by_user_id`) and names them here, so the
   * handler can (a) assert the auth it received really is that approver
   * before writing and (b) stamp the row's provenance as `ai_suggested`.
   * Absent for every other release and for every direct call, which is what
   * lets the handler keep `source: 'manual'` for a human's own tool call.
   */
  approverRelease?: { approverUserId: string };
  /**
   * A-W05 (D13a/Q4) — the SAME capture anchor `captureContextFrom`
   * (`artifacts/toolResultCapture.ts`) computed for this call, threaded
   * through so `read_artifact`'s handler can scope `findArtifactForCaller`
   * to exactly the run or chat session THIS call is running in. Capture
   * writes and this read must use one anchor or a model could read an
   * artifact captured from a different session of the same user —
   * `findArtifactForCaller` deliberately does not accept "any session
   * belonging to this user" as a match.
   *
   * Structurally identical to `ArtifactCallerAnchor`
   * (`artifacts/artifactService.ts`) — typed independently here rather than
   * imported, because this file must not depend on the artifact service
   * layer for an otherwise-unrelated execution-input bag.
   *
   * Set by `executeTool` ONLY for `read_artifact` (a name check, not a
   * blanket computation folded into every call's context) so every other
   * tool's `context` identity is unaffected — see the comment at the call
   * site in `aiTools.ts`. Absent for a call with no attributable org/run/
   * session (an unauthenticated or system-scope caller), which is what makes
   * "no anchor" a safe, typed refusal rather than an unscoped lookup.
   */
  captureAnchor?: { orgId: string; runId?: string | null; sessionId?: string | null };
  /**
   * Topology M4-D1 (#6000): the site context the topology gate
   * (`topology/aiToolGate.ts`) issued for THIS call — the pinned site of a
   * server-owned topology session (or a one-site MCP key), with the caller's
   * live permissions. Set by `executeTool` ONLY for topology tool names, and
   * always OVERWRITTEN there: a caller-supplied value is never trusted, and a
   * topology handler that finds it absent refuses rather than resolving a site
   * from its own input.
   */
  topologyRequest?: TopologyRequestContext;
  /**
   * Topology M4 Task 2: the alias scope for host identities in THIS call's
   * result — `session:<id>` inside a topology session (stable across the
   * investigation's tool calls and its evidence snapshot), otherwise a fresh
   * request-local scope. Set by `executeTool` next to `topologyRequest`.
   */
  topologyAliasScope?: string;
  /**
   * Topology M4 Task 4 (#6000): a `diagnose_connectivity` release's effect,
   * re-derived by the release path and verified against the approval's pinned
   * effect digest (`computeEffectDigestForRelease`). Set ONLY from that
   * recompute on a MATCH — never from model arguments or the auth identity —
   * and travels with `actionIntentId`. The handler refuses without both, and
   * still re-derives and re-binds the effect inside its acceptance
   * transaction; it never selects a different origin or target.
   */
  verifiedTopologyDiagnostic?: VerifiedTopologyDiagnostic;
};
