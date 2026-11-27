import type { z } from 'zod';
import { parseRestorePointOutcome, type commandResultSchema } from '../routes/agents/schemas';
import { redactSecretsFromOutput } from './secretRedaction';
import { isRawStdoutArtifactCommand } from './commandAudit';
import { collapseAgentReportedTimeoutStatus } from './commandResultAcceptance';
import { installerSecretsFromPayload, scrubInstallerSecrets } from './installerSecretScrub';

/**
 * The object persisted into `device_commands.result` for an agent command
 * result. Shared by both ingest legs — the WebSocket handler
 * (routes/agentWs.ts) and its REST twin (routes/agents/commands.ts) — which
 * used to carry byte-identical private copies of this function.
 *
 * It is built field-by-field on purpose (redaction, timeout collapse), so a
 * new wire field is dropped here unless it is added explicitly — and whatever
 * is dropped never reaches executeCommand's caller. `errorCode` (#4026) is the
 * case in point: without it, classifyCommandFailure keeps matching prose even
 * for agents that send the typed code.
 */
export function buildStoredCommandResult(
  commandType: string,
  result: z.infer<typeof commandResultSchema>,
  stdout: string | undefined,
  /** The command's persisted payload: a framework-provider install scrubs its link and file name (#8170). */
  commandPayload?: unknown,
) {
  const installerSecrets = installerSecretsFromPayload(commandPayload);
  const stored = <T extends string | null | undefined>(text: T): T | string =>
    installerSecrets && text != null ? scrubInstallerSecrets(text, installerSecrets) : text;
  // Defense-in-depth: strip full PEM private-key blocks from agent output
  // BEFORE it is persisted and later shown to scripts:read users. Pre-update
  // agents don't redact server-side-visible output, so we redact here.
  // Preserve null/undefined (don't coerce to '') to keep the stored shape
  // stable; exitCode/status/durationMs are untouched.
  //
  // Exception: artifact-bearing stdout (capture_pprof base64 profiles) must be
  // stored byte-for-byte -- the redaction patterns statistically fire inside
  // megabytes of random base64 and would silently corrupt the artifact (#2401).
  const skipStdoutRedaction = isRawStdoutArtifactCommand(commandType);
  return {
    // See collapseAgentReportedTimeoutStatus: an agent-reported 'timeout'
    // must never be stored verbatim — that literal string doubles as the
    // server's own reopen marker.
    status: collapseAgentReportedTimeoutStatus(result.status),
    exitCode: result.exitCode,
    stdout: stored(stdout != null && !skipStdoutRedaction ? redactCommandStdout(commandType, stdout) : stdout),
    stderr: stored(result.stderr != null ? redactSecretsFromOutput(result.stderr) : result.stderr),
    durationMs: result.durationMs,
    error: stored(result.error != null
      ? redactSecretsFromOutput(result.error)
      : result.status === 'timeout' ? 'Agent reported a timeout' : result.error),
    // A machine code from a closed vocabulary, not free text: nothing to
    // redact. Absent for agents that predate it.
    errorCode: result.errorCode,
    // #4609 W06: the validated checkpoint outcome, only when the agent sent
    // one and it parsed (unknown keys stripped; an invalid outcome is not
    // persisted). Its free-text message/description are redacted by the parse
    // (classifyRestorePointOutcome). Absent key -> nothing added, so results from every
    // agent shipped to date store exactly what they did before.
    ...(result.restorePoint !== undefined ? restorePointStoredField(result.restorePoint) : {}),
  };
}

/**
 * Command types whose stdout is a typed JSON result carrying one captured
 * screen image, and the path of that image field (#12795). Mirrors the agent's
 * `ScreenshotResponse` (take_screenshot) and `ComputerActionResponse.Screenshot`
 * (computer_action) in agent/internal/remote/tools/types.go.
 *
 * The secret patterns are unanchored, so they fire by chance inside a long
 * base64 image (`AKIA` + 16 alphanumerics, case-insensitive) and rewrite a
 * span of it: the stored screenshot no longer decodes, and a static screen
 * corrupts the same way on every retry. The exemption is by command type and
 * field path, never by "the value looks like base64": a base64-looking value
 * in any other field, or this field in any other command type, is text.
 */
const IMAGE_FIELD_PATH: Readonly<Record<string, readonly string[]>> = {
  take_screenshot: ['imageBase64'],
  computer_action: ['screenshot', 'imageBase64'],
};

const BASE64_TEXT = /^[A-Za-z0-9+/]+={0,2}$/;
const JPEG_START = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

/**
 * True only for canonical standard base64 that decodes to a whole JPEG (SOI at
 * the start, EOI at the end) — what the agent's screenshot encoder produces.
 * Anything else in the image field (plain text, non-image base64, a truncated
 * or padded-bits variant) is not exempt and is redacted as text, so a command
 * result cannot carry arbitrary text through the field by naming it
 * `imageBase64`.
 */
function isEncodedJpeg(value: string): boolean {
  if (value.length % 4 !== 0 || !BASE64_TEXT.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) return false;
  return bytes.length >= JPEG_START.length + JPEG_END.length
    && bytes.subarray(0, JPEG_START.length).equals(JPEG_START)
    && bytes.subarray(bytes.length - JPEG_END.length).equals(JPEG_END);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The object holding the image field at `path`, or null when the path does not resolve to one. */
function imageFieldHolder(root: unknown, path: readonly string[]): Record<string, unknown> | null {
  let node: unknown = root;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(node) || !Object.hasOwn(node, key)) return null;
    node = node[key];
  }
  return isPlainObject(node) ? node : null;
}

/**
 * Redacts persisted command stdout. For an image-bearing command type whose
 * stdout parses as its typed result and whose image field holds a real JPEG,
 * the image is set aside, the rest of the result is redacted as text with the
 * same rules as any other stdout, and the image is put back. Every other case
 * is the plain text pass, as before.
 *
 * The stored text is re-serialized from the parsed result, so nothing in the
 * original text other than what JSON.parse kept (e.g. an earlier duplicate
 * `imageBase64` key) can reach storage unredacted. If redaction breaks the
 * JSON (the connection-string rule runs to the next whitespace), the redacted
 * text is stored without the image: fail closed, never re-attach blindly.
 */
function redactCommandStdout(commandType: string, stdout: string): string {
  const path = IMAGE_FIELD_PATH[commandType];
  if (!path) return redactSecretsFromOutput(stdout);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return redactSecretsFromOutput(stdout);
  }
  const imageKey = path[path.length - 1]!;
  const holder = imageFieldHolder(parsed, path);
  const image = holder && Object.hasOwn(holder, imageKey) ? holder[imageKey] : undefined;
  if (typeof image !== 'string' || !isEncodedJpeg(image)) return redactSecretsFromOutput(stdout);

  holder![imageKey] = '';
  const redacted = redactSecretsFromOutput(JSON.stringify(parsed));
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(redacted);
  } catch {
    return redacted;
  }
  const redactedHolder = imageFieldHolder(reparsed, path);
  if (!redactedHolder || redactedHolder[imageKey] !== '') return redacted;
  redactedHolder[imageKey] = image;
  return JSON.stringify(reparsed);
}

function restorePointStoredField(raw: unknown) {
  const outcome = parseRestorePointOutcome(raw);
  return outcome ? { restorePoint: outcome } : {};
}
