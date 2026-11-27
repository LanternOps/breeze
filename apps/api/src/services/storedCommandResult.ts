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

/** The value at the image field path of `text` parsed as JSON; undefined when it does not parse or resolve. */
function imageFieldValue(text: string, path: readonly string[]): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const imageKey = path[path.length - 1]!;
  const holder = imageFieldHolder(parsed, path);
  return holder && Object.hasOwn(holder, imageKey) ? holder[imageKey] : undefined;
}

/**
 * Redacts persisted command stdout. For an image-bearing command type whose
 * stdout parses as its typed result and whose image field holds a real JPEG,
 * the image is cut out of the ORIGINAL text, that text gets the same
 * whole-text pass as any other stdout, and the image is put back where it was
 * cut. Every other case is the plain text pass, as before.
 *
 * Redaction never runs on a re-serialized form: JSON.parse reorders
 * integer-like keys and decodes escapes, either of which can move a secret
 * out of the span a rule matches in the original. Everything stored except
 * the image is byte-identical to `redactSecretsFromOutput` of the stdout with
 * the image emptied. Any throw on the way falls back to the plain text pass
 * over the original stdout, so a hostile result can neither fail the ingest
 * nor skip redaction.
 */
function redactCommandStdout(commandType: string, stdout: string): string {
  const path = Object.hasOwn(IMAGE_FIELD_PATH, commandType) ? IMAGE_FIELD_PATH[commandType] : undefined;
  if (!path) return redactSecretsFromOutput(stdout);
  try {
    const kept = redactKeepingImage(commandType, path, stdout);
    if (kept !== null) return kept;
  } catch {
    console.warn(`[storedCommandResult] ${commandType} result could not be processed (${stdout.length} chars); stored as redacted text`);
  }
  return redactSecretsFromOutput(stdout);
}

/**
 * The redacted stdout with the image kept (or dropped, see dropImage), or
 * null when the image cannot be cut out of the original text unambiguously;
 * the caller then runs the plain text pass over the whole stdout.
 */
function redactKeepingImage(commandType: string, path: readonly string[], stdout: string): string | null {
  const image = imageFieldValue(stdout, path);
  if (typeof image !== 'string' || !isEncodedJpeg(image)) return null;

  // Locate the image in the original text. Base64 needs no JSON escaping, so
  // the agent writes it verbatim. Require exactly one quoted verbatim copy,
  // and require that emptying it empties the image field as JSON.parse
  // resolves it. Otherwise (an escaped copy, a second copy in a text field, a
  // copy under an earlier duplicate key) nothing is exempt. Removing base64
  // characters from between two quotes cannot change how the rest of the text
  // tokenizes, so only that one string value changes.
  const quoted = `"${image}"`;
  const at = stdout.indexOf(quoted);
  if (at < 0 || stdout.indexOf(quoted, at + 1) >= 0) return null;
  const cut = at + 1;
  const blanked = stdout.slice(0, cut) + stdout.slice(cut + image.length);
  if (imageFieldValue(blanked, path) !== '') return null;

  const redacted = redactSecretsFromOutput(blanked);
  // Every drop stores this same text. The log carries lengths only, never
  // content: the text may hold what was just redacted out of it.
  const dropImage = (why: string) => {
    console.warn(`[storedCommandResult] ${commandType} screenshot dropped: ${why} (${image.length} image chars); stored as redacted text`);
    return redacted;
  };

  // Find the cut in the redacted text. When redacting the two sides apart
  // gives the same text as redacting them together, no rule matched across
  // the cut, so the cut sits at the end of the redacted left side. It must
  // still sit between two quotes, and the image put back there must be what
  // JSON.parse resolves as the image field; otherwise the image is dropped.
  const head = redactSecretsFromOutput(blanked.slice(0, cut));
  if (redacted !== head + redactSecretsFromOutput(blanked.slice(cut))) {
    return dropImage('a redaction spans the image field');
  }
  if (redacted[head.length - 1] !== '"' || redacted[head.length] !== '"') {
    return dropImage('redaction changed the image field');
  }
  const kept = redacted.slice(0, head.length) + image + redacted.slice(head.length);
  if (imageFieldValue(kept, path) !== image) return dropImage('redaction changed the result structure');
  return kept;
}

function restorePointStoredField(raw: unknown) {
  const outcome = parseRestorePointOutcome(raw);
  return outcome ? { restorePoint: outcome } : {};
}
