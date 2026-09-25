import { aiArtifactCaptureEnabled, breezeRegion } from '../../config/env';
import type { AuthContext } from '../../middleware/auth';
import { MAX_TOOL_RESULT_CHARS } from '../aiToolOutput';
import { captureException } from '../sentry';
import { ARTIFACT_PREVIEW_BYTES, REDACTED_CAPTURE_NAME_INFIX, buildPreviews, createArtifact } from './artifactService';
import type { BlobRegion } from './blobStorage';
import { redactForCapture } from './captureRedaction';

/**
 * Large tool-result capture (execution-plane spec §5.2, §9).
 *
 * Called from INSIDE `executeTool`, after the handler and before any compaction
 * (services/aiTools.ts). When the raw serialized result exceeds the same
 * `MAX_TOOL_RESULT_CHARS` the chat compaction uses, `redactForCapture(raw)` is
 * persisted (A-W05 D13b/Q5 — REDACT THEN CAPTURE, never the raw bytes: the
 * artifact store is org-downloadable and must never hold credential material)
 * as an `input_capture` artifact and the result becomes
 *
 *     { artifact: { handle, bytes, contentType, head, tail }, compacted: <redacted> }
 *
 * which `compactToolResultForChat` then compacts in place (Task 7). The model
 * keeps exactly the view it has today (redaction was already applied to that
 * view before this wave) PLUS a handle it can stage. The capture THRESHOLD is
 * still measured on the raw string's length, so the non-capture path (at or
 * below the threshold) is byte-identical to before this wave.
 *
 * PASSTHROUGH IS THE DEFAULT. With a null context — no org, no anchor, or a
 * `captureExempt` tool — with the flag off, or at or below the threshold, the
 * raw string is returned byte-identically. A self-hoster's tool results are
 * unchanged by this wave.
 *
 * NO DATABASE ACCESS OF ITS OWN. Attribution is already present at the call:
 * the agent run path carries it on the auth PRINCIPAL, and the chat path hands
 * in a `CaptureScope`. An earlier draft resolved the run from the session with
 * a memoized query behind a dedicated partial index; that is gone. If this file
 * ever needs `db` again, the contract has been broken.
 *
 * FAILURE IS NEVER A FALLBACK (§9). A blob or row failure yields
 * `{ error: 'artifact_store_unavailable' }`; returning the raw result inline
 * would hand the model the exact payload the context cap exists to keep out.
 */

/** Refuse to buffer more than this into one artifact. Far above any tool result. */
export const CAPTURE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * What a CHAT caller supplies through `ExecuteToolOptions.capture` — the only
 * thing any call site ever constructs. Both fields come from the active session
 * (`ActiveSession.orgId` / `.breezeSessionId`), because `auth.orgId` is null for
 * a partner-scope login and a chat call has no run to anchor to.
 */
export interface CaptureScope {
  orgId: string;
  /** `ai_sessions.id` — what the artifact row's `session_id` FK points at. */
  sessionId: string;
}

export interface CaptureContext {
  orgId: string;
  /** The agent run this capture belongs to, or null for a plain chat capture. */
  runId: string | null;
  /** `ai_sessions.id`. Always null when `runId` is set — one anchor per artifact. */
  sessionId: string | null;
  region: BlobRegion;
  toolName: string;
}

/**
 * Derive the capture attribution for one `executeTool` invocation, or null for
 * "do not capture" (which is passthrough, never an error).
 *
 * TWO PATHS, ONE FUNCTION (reconciliation R4/R5):
 *
 *   - The AGENT RUN path needs no call-site change at all. Its auth context is
 *     built from the run row itself, so `auth.principal` already carries
 *     `runId` and `auth.orgId` already IS `run.orgId`
 *     (services/aiAgents/agentAuthContext.ts:78, :89).
 *   - The CHAT path supplies `opts.capture` from its active session, because
 *     `auth.orgId` is null for a partner-scope login and there is no run.
 *
 * THE ORG IS NEVER GUESSED. `auth.accessibleOrgIds` is deliberately NOT
 * consulted: picking the single entry of a one-org array is a guess, and a
 * guessed org on a tenant-scoped row is a tenancy bug waiting for its second
 * org. No org means no capture.
 *
 * ONE ANCHOR. `runId` wins; a run-anchored artifact stores no session, so the
 * run page's list cannot double-count through a session join.
 *
 * The options parameter is typed STRUCTURALLY rather than as
 * `ExecuteToolOptions`: `aiTools.ts` value-imports this module, so importing
 * its type back would be a cycle. `ExecuteToolOptions` satisfies this shape.
 */
export function captureContextFrom(
  auth: AuthContext,
  opts: { capture?: CaptureScope } | undefined,
  toolName: string,
): CaptureContext | null {
  const orgId = opts?.capture?.orgId ?? auth.orgId ?? null;
  // `principal` is typed non-optional but is absent on hand-built contexts (test
  // doubles, and any caller that predates the field). Capture runs on EVERY tool
  // call, so it must never be the thing that throws — `middleware/auth.ts` reads
  // it the same defensive way (isAiAgentPrincipal, dbAccessContextFromAuth).
  const principal = auth.principal as AuthContext['principal'] | undefined;
  const runId = principal?.kind === 'ai_agent' ? principal.runId : null;
  const sessionId = runId ? null : (opts?.capture?.sessionId ?? null);
  if (!orgId) return null;
  if (!runId && !sessionId) return null;
  return { orgId, runId, sessionId, region: breezeRegion(), toolName };
}

function looksLikeJson(raw: string): boolean {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

export async function captureLargeToolResult(
  raw: string,
  ctx: CaptureContext | null,
): Promise<string> {
  if (ctx === null) return raw;
  // Threshold stays on the RAW string — measuring after redaction would let a
  // large-but-redactable payload dodge capture depending on how much of it
  // happened to be wiped.
  if (raw.length <= MAX_TOOL_RESULT_CHARS) return raw;
  if (!aiArtifactCaptureEnabled()) return raw;

  // A-W05 (D13b / Q5): the artifact store receives the REDACTED payload —
  // never the raw one — so the org-downloadable blob never holds credential
  // material. The model's own in-context view (`compacted`) is unaffected:
  // it mirrors `stored`, which is byte-identical to `raw` whenever nothing in
  // it matched the redaction denylist.
  const stored = redactForCapture(raw);
  const isJson = looksLikeJson(stored);
  const contentType = isJson ? 'application/json' : 'text/plain; charset=utf-8';
  const body = Buffer.from(stored, 'utf8');
  if (body.length > CAPTURE_MAX_BYTES) {
    return JSON.stringify({
      error: 'artifact_store_unavailable',
      message: `This tool result is too large to store (${body.length} bytes). Narrow the query and try again.`,
    });
  }

  try {
    const record = await createArtifact({
      orgId: ctx.orgId,
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      kind: 'input_capture',
      name: `${ctx.toolName}${REDACTED_CAPTURE_NAME_INFIX}${isJson ? 'json' : 'txt'}`,
      contentType,
      body,
      maxBytes: CAPTURE_MAX_BYTES,
      createdByTool: ctx.toolName,
      region: ctx.region,
    });
    // Previews are built from the REDACTED body too (Q5) — the whole point of
    // redact-then-capture is that nothing downstream of this point, including
    // what a technician sees on the run page, ever holds the raw bytes.
    const { headPreview, tailPreview } = buildPreviews(body);
    return JSON.stringify({
      artifact: {
        handle: record.id,
        bytes: record.bytes,
        contentType: record.contentType,
        head: headPreview.slice(0, ARTIFACT_PREVIEW_BYTES),
        tail: tailPreview.slice(-ARTIFACT_PREVIEW_BYTES),
      },
      compacted: stored,
    });
  } catch (err) {
    // §9: typed tool error, raw result NOT returned inline. The message tells
    // the model what to do differently — it cannot retry its way out of this.
    captureException(err);
    console.error('[artifacts] capture failed; returning artifact_store_unavailable', err);
    return JSON.stringify({
      error: 'artifact_store_unavailable',
      message: 'This tool result was too large for the conversation and could not be stored. Narrow the query (fewer devices, a shorter time range, or a filter) and try again.',
    });
  }
}
