import type { scripts } from '../db/schema';
import type { RunScriptSnapshot } from './actionIntents/runScriptSnapshot';
import type { TenantVariableScope } from './tenantVariableResolution';

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
};
