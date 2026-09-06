/**
 * Agent command-failure classification for **every** systemTools route.
 *
 * Named for the File Browser because that is where it was extracted from, but
 * as of #4025 `processes`, `services`, `registry`, `eventLogs` and
 * `scheduledTasks` all classify through it too. The name is kept so the merged
 * `fileBrowserHelpers.test.ts` — which owns the Cloudflare property test over
 * every classifier outcome — keeps its co-located pairing; treat this module as
 * the shared one it now is, not as file-browser-private.
 */
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  DEVICE_UNREACHABLE_ERROR,
  type CommandResult,
} from '../../services/commandQueue';

// True for any agent CommandResult that should map to an HTTP error response.
// Both 'failed' and 'timeout' must be treated as failures: previously the
// route code only checked 'failed', which let timeouts silently fall through
// to the JSON.parse path and surface a generic 500.
//
// Written as an exhaustive switch rather than `status === 'failed' || status
// === 'timeout'` so that adding a fourth CommandResult status is a COMPILE
// ERROR here instead of a silent new fall-through. That is exactly how #4025
// happened: a status the success path had never considered ('timeout') was
// treated as success by every route that enumerated failures positively.
export function isCommandFailure(result: CommandResult): boolean {
  switch (result.status) {
    case 'failed':
    case 'timeout':
      return true;
    case 'completed':
      return false;
    default: {
      // If this stops compiling, a new status was added to CommandResult.
      // Decide deliberately whether it is a failure — do not let it default.
      const exhaustive: never = result.status;
      void exhaustive;
      // Fail closed if one ever slips past the type system (an `any` at a
      // call site, a payload off the wire): an unrecognised status is treated
      // as a failure, never silently as a success. Returning `exhaustive`
      // here would return the status STRING from a function typed `boolean`.
      return true;
    }
  }
}

/**
 * What actually went wrong, independent of how it is spelled on the wire.
 *
 * Callers that need to make a decision (is this retryable? did the device
 * maybe complete the work anyway?) must branch on this, NEVER on the HTTP
 * status: several kinds deliberately share a status, and the statuses
 * themselves are constrained by the Cloudflare rule below rather than by pure
 * semantics.
 */
export type CommandFailureKind =
  | 'device_unreachable'
  | 'device_offline'
  | 'agent_timeout'
  | 'path_not_found'
  | 'path_conflict'
  | 'agent_command_rejected'
  | 'agent_execution_failed';

export type CommandFailure = {
  kind: CommandFailureKind;
  message: string;
  status: ContentfulStatusCode;
  /** Stable machine-readable discriminant, mirrored into the response body. */
  code: CommandFailureKind;
  /** Set only when the device may have completed the work despite the error. */
  unverified?: true;
};

/**
 * NEVER map an agent failure to 502 or 504.
 *
 * Cloudflare fronts the hosted deployments and, by its own documentation,
 * "returns a Cloudflare-branded HTTP 502 or 504 error when your origin web
 * server responds with a standard HTTP 502 bad gateway or 504 gateway timeout
 * error". Origin-error pass-thru is Enterprise-only and is not enabled. The
 * branded page REPLACES our JSON body, so the client's `response.json()`
 * throws and every message below is reduced to a generic "Failed to ..." — the
 * exact production bug this classifier exists to prevent: a user was told
 * "Failed to download" when the agent had actually said
 * "file too large: 8981850 bytes (max 1048576 bytes)".
 *
 * Self-hosted deployments have no Cloudflare in front and saw the real message
 * all along, which is why this survived so long undetected.
 *
 * 500 and 503 pass through Cloudflare untouched, as do all 4xx.
 *
 * Exported so fileBrowserHelpers.test.ts can assert it against every
 * classifier outcome — a future edit cannot quietly reintroduce a swallowed
 * body.
 */
export const CLOUDFLARE_SWALLOWED_STATUSES = [502, 504] as const;

/**
 * Deterministic refusals: the agent understood a well-formed command and
 * declined to carry it out (a policy denial, a size cap, a shape mismatch).
 * These are NOT server faults — surfacing them as 5xx both misleads the
 * technician and inflates our error-rate alerting with working-as-intended
 * outcomes.
 *
 * Matched against the agent's prose because `CommandResult` carries only
 * `status` and a human string today. That is a known weakness, not a
 * preference: an unrecognised refusal degrades to `agent_execution_failed`
 * (500), which is the safe direction — it over-reports a fault rather than
 * silently claiming the user can fix something they cannot. The durable fix is
 * a typed `errorCode` on the Go CommandResult; see the follow-up issue.
 *
 * Every pattern below is anchored to a literal in
 * agent/internal/remote/tools/fileops.go.
 */
const REFUSAL_PATTERNS: readonly RegExp[] = [
  /^file too large:/i,
  /file write payload too large/i,
  /^path is a directory, not a file/i,
  /denied on sensitive path/i,
  /^operation denied on system path:/i,
  /^recursive delete denied on top-level path:/i,
  /denied: cannot verify directory contents/i,
  /^cannot copy directory into itself:/i,
  /^directory too large to clear/i,
  /^trash metadata exceeds maximum size/i,
  /^unsupported encoding:/i,
  /^(path|destPath|newPath|oldPath|sourcePath|trashId) is required/i,
];

/** Refusals that are specifically a state conflict the user can reconcile. */
const CONFLICT_PATTERNS: readonly RegExp[] = [
  /^cannot restore: path already exists:/i,
];

/**
 * Absent-path refusals. Kept separate from the generic refusals so they get a
 * 404 rather than a 422 — the agent spells this three different ways and only
 * one of them contains the words "not found", which is why the download route
 * used to miss `path does not exist:` and return a 502 for a plain typo.
 */
const NOT_FOUND_PATTERNS: readonly RegExp[] = [
  /not found/i,
  /^path does not exist:/i,
  /^source path does not exist:/i,
];

function matchesAny(patterns: readonly RegExp[], raw: string): boolean {
  return patterns.some((pattern) => pattern.test(raw));
}

/**
 * Single source of truth for "the agent did not do what we asked".
 *
 * `mutating` marks routes that change state on the device. It only affects
 * timeouts: on a timeout we genuinely cannot tell whether the device completed
 * the operation (the queue marks the row failed, and a late result only
 * updates rows still marked `sent`), so a mutation is reported as
 * `unverified` and the message tells the user to verify before retrying.
 * Re-running a delete/move/purge against a half-completed state can compound
 * the damage.
 */
export function classifyCommandFailure(
  result: CommandResult,
  opts: { mutating?: boolean } = {},
): CommandFailure {
  const raw = result.error || '';

  if (raw === DEVICE_UNREACHABLE_ERROR) {
    return {
      kind: 'device_unreachable',
      message: DEVICE_UNREACHABLE_ERROR,
      status: 503,
      code: 'device_unreachable',
    };
  }

  // `status === 'timeout'` is the reliable signal; the prose test catches
  // agents and queue paths that report a timeout as a plain failure. Both must
  // land here, or a timed-out mutation gets reported as a verified failure and
  // the user retries a delete that may already have happened.
  if (result.status === 'timeout' || /timed out|did not complete/i.test(raw)) {
    return {
      kind: 'agent_timeout',
      message: opts.mutating
        ? "The device didn't respond in time. The operation may have completed — refresh to verify before retrying."
        : "The device didn't respond in time. This usually means a brief network issue. Please try again.",
      status: 503,
      code: 'agent_timeout',
      ...(opts.mutating ? { unverified: true as const } : {}),
    };
  }

  if (/cannot execute command|is offline|is unknown/i.test(raw)) {
    // The queue refuses ANY non-online device with the same sentence:
    // `Device is ${device.status}, cannot execute command`
    // (commandQueue.ts:1013, inside executeCommand — the similar string at
    // :832 returns a bare `{ error }` with no `status`, is not a
    // CommandResult, and never reaches this classifier).
    // `device_status` has seven values, so answering a flat "The device is
    // offline." is wrong for five of the six non-online ones — and not in a
    // cosmetic way:
    //
    //   - `updating` is set on every agent self-update (agentWs.ts:2156), so a
    //     technician who restarts a service mid-upgrade is told the device is
    //     offline and goes hunting a network fault that isn't there.
    //   - `quarantined` is a security-containment state. Reporting it as
    //     "offline" hides the containment from the person investigating.
    //
    // Keep the clean copy for the genuinely-offline case (the raw string's
    // ", cannot execute command" tail is internal noise), and name the real
    // state otherwise. `code` stays `device_offline` either way: it is the
    // machine-readable "device would not take the command" discriminant, and
    // callers branch on it, not on the prose.
    //
    // The guard regex above also admits two shapes this sentence does not
    // cover (`is offline` / `is unknown` on their own). Those keep the clean
    // default rather than echoing `raw`: no production code emits them today,
    // and passing unrecognised internal text through with a confident 503
    // would be worse than the generic sentence — the 500 fallback at the end
    // of this function is where genuinely unclassified text belongs.
    const deviceState = /^Device is (\w+), cannot execute command$/i.exec(raw)?.[1]?.toLowerCase();
    return {
      kind: 'device_offline',
      message:
        deviceState && deviceState !== 'offline'
          ? `The device is ${deviceState} and cannot run commands.`
          : 'The device is offline.',
      status: 503,
      code: 'device_offline',
    };
  }

  if (matchesAny(NOT_FOUND_PATTERNS, raw)) {
    return { kind: 'path_not_found', message: raw, status: 404, code: 'path_not_found' };
  }

  if (matchesAny(CONFLICT_PATTERNS, raw)) {
    return { kind: 'path_conflict', message: raw, status: 409, code: 'path_conflict' };
  }

  if (matchesAny(REFUSAL_PATTERNS, raw)) {
    return {
      kind: 'agent_command_rejected',
      message: raw,
      status: 422,
      code: 'agent_command_rejected',
    };
  }

  return {
    kind: 'agent_execution_failed',
    message: raw,
    status: 500,
    code: 'agent_execution_failed',
  };
}

// Map a failed/timed-out agent CommandResult to a user-facing message + HTTP
// status + machine-readable code. Thin wrapper over classifyCommandFailure
// that applies the route's fallback text when the agent gave us nothing to
// show.
//
// `mutating` flips the timeout-branch message to warn the user that the
// operation may have already completed on the device, so they verify before
// retrying. Use it for any route that changes state on success.
export function mapCommandFailure(
  result: CommandResult,
  fallback: string,
  opts: { mutating?: boolean } = {},
): CommandFailure {
  const failure = classifyCommandFailure(result, opts);
  return failure.message ? failure : { ...failure, message: fallback };
}

// Bulk-item variant for routes that mutate state per item (copy/move/delete/
// restore/trash-purge). On a timeout we cannot tell whether the agent
// completed the operation or not — telling the user "brief network issue,
// please try again" is dangerous because re-running a delete/move/purge
// against a half-completed state can compound the damage. Mark these as
// `unverified` so the UI can prompt the user to refresh and check.
export function buildBulkItemFailure(result: CommandResult): {
  message: string;
  code: CommandFailureKind;
  unverified: boolean;
} {
  // Always classified as mutating: every caller of this helper changes device
  // state. Deriving `unverified` from the classifier (rather than re-testing
  // `status === 'timeout'` here) is what keeps a prose-only timeout —
  // `{status:'failed', error:'command timed out'}` — from being reported as a
  // verified failure that is safe to retry.
  const failure = mapCommandFailure(result, 'Operation failed.', { mutating: true });
  return {
    message: failure.message,
    code: failure.code,
    unverified: failure.unverified === true,
  };
}

// Single-item upload variant. Mirrors buildBulkItemFailure, but returns the
// full { error, code, unverified?, status } shape the upload route needs.
export function buildSingleItemUploadBody(
  result: CommandResult,
  fallback: string,
): {
  error: string;
  code: CommandFailureKind;
  status: ContentfulStatusCode;
  unverified?: true;
} {
  const failure = mapCommandFailure(result, fallback, { mutating: true });
  // Branch on the classified kind, never on the HTTP status: timeout and
  // offline both answer 503, so a status test here would silently drop the
  // `unverified` warning that tells the user their upload may have landed.
  return {
    error: failure.message,
    code: failure.code,
    status: failure.status,
    ...(failure.unverified ? { unverified: true as const } : {}),
  };
}

/**
 * The whole error response for a route that must stop on an agent failure:
 * the JSON body and the status to send it with.
 *
 * Every systemTools route needs the identical three-part shape (`error`,
 * `code`, and `unverified` only when set), and hand-rolling it at each of the
 * ~25 call sites is how the `unverified` flag gets dropped from one of them —
 * exactly the class of copy-paste divergence that produced issue #4025. Pass
 * `mutating: true` from any route that changes device state so a timeout is
 * reported as unverified rather than as a plain retryable error.
 *
 * Returns body and status separately rather than one flat object because
 * several routes already bind a local `status` (e.g. the service-list query
 * filter), which a destructured `{ status, ...payload }` would collide with.
 */
export function buildCommandFailureResponse(
  result: CommandResult,
  fallback: string,
  opts: { mutating?: boolean } = {},
): {
  body: { error: string; code: CommandFailureKind; unverified?: true };
  status: ContentfulStatusCode;
} {
  const failure = mapCommandFailure(result, fallback, opts);
  return {
    body: {
      error: failure.message,
      code: failure.code,
      ...(failure.unverified ? { unverified: true as const } : {}),
    },
    status: failure.status,
  };
}

// Tag audit-log errorMessage so admins reviewing the audit trail can spot
// commands whose final state on the device is unverified. Returns undefined
// for successes so callers can pass the result through unchanged.
export function auditErrorMessage(result: CommandResult): string | undefined {
  // Classified rather than testing `status === 'timeout'` directly, so a
  // prose-only timeout is tagged `[unverified]` in the audit trail too — the
  // trail and the API response must not disagree about whether a device's
  // final state was confirmed.
  //
  // Gated on isCommandFailure so classification never runs on a COMPLETED
  // command: the prose test would otherwise tag a successful command whose
  // output merely mentions "timed out" as unverified.
  if (isCommandFailure(result) && classifyCommandFailure(result).kind === 'agent_timeout') {
    return `[unverified] ${result.error || 'Command timed out — agent state not confirmed.'}`;
  }
  return result.error || undefined;
}
