/**
 * Extracts a script's custom-field write-back request from a command result.
 *
 * NOT A SECRETS CHANNEL. Channel A rides stdout, and stdout is persisted to
 * `script_executions.stdout` for any `scripts:read` user. A value written this
 * way is visible there as well as on the device record.
 *
 * Channel B (`result.customFieldWrites`, schemaVersion 1) is namespaced and
 * versioned on purpose: `toWSCommandResult` (agent/internal/heartbeat/
 * heartbeat.go) reparses whole-JSON stdout into the envelope's `result`, so an
 * unnamespaced `customFields` key would turn any script that prints such a
 * document into an unintended write-back.
 *
 * Known limitation: the agent's `SanitizeOutput` and the server's mirror
 * `redactSecretsFromOutput` rewrite `(api_key|token|secret|password|…)\s*[=:]…`
 * pairs to `$1=[REDACTED]` BEFORE the marker reaches here, so a marker whose
 * JSON contains such a key fails `JSON.parse`. That is reported loudly as
 * `marker_unparseable` rather than dropped, so the failure is diagnosable.
 */

export const CUSTOM_FIELD_MARKER = '::breeze:custom-fields::';
export const MAX_MARKER_LINES = 20;
export const MAX_MARKER_KEYS = 50;
export const MAX_MARKER_JSON_BYTES = 8192;

export type MarkerFailureReason =
  | 'marker_unparseable'
  | 'too_many_lines'
  | 'too_many_keys'
  | 'marker_too_large'
  | 'forbidden_key'
  // The envelope announced itself but could not be used. Distinct from "no
  // envelope at all", which is silent because it is the normal case.
  | 'envelope_unparseable'
  | 'envelope_unsupported_version';

export interface ExtractedCustomFieldWrites {
  /** Candidate key -> raw value. Empty means "nothing to do". */
  candidates: Map<string, unknown>;
  /** Lines that looked like markers but could not be used. Never silent. */
  failures: Array<{ reason: MarkerFailureReason; sample: string }>;
  /** Which channel supplied `candidates`. */
  channel: 'none' | 'stdout' | 'envelope';
}

/**
 * `JSON.parse` creates a real own `__proto__` property (object literals do
 * not), and a later `merged[key] = value` on a plain object would then reassign
 * the prototype. Field keys are lowercase identifiers, so dropping these costs
 * nothing real.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sample(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * Channel B: `{ customFieldWrites: { schemaVersion: 1, fields: {...} } }`.
 *
 * Three outcomes, not two. `absent` means the result simply carried no
 * write-back request — the normal case, and silent. Anything else means the
 * envelope announced itself and then could not be used, which must be reported
 * or a version-skewed agent looks identical to a script with nothing to say.
 */
type EnvelopeRead =
  | { kind: 'absent' }
  | { kind: 'ok'; fields: Record<string, unknown> }
  | { kind: 'failed'; reason: 'envelope_unparseable' | 'envelope_unsupported_version' };

function readEnvelope(resultEnvelope: unknown): EnvelopeRead {
  if (!isPlainObject(resultEnvelope)) return { kind: 'absent' };
  if (!('customFieldWrites' in resultEnvelope)) return { kind: 'absent' };

  const writes = resultEnvelope.customFieldWrites;
  if (!isPlainObject(writes)) return { kind: 'failed', reason: 'envelope_unparseable' };
  if (writes.schemaVersion !== 1) {
    return { kind: 'failed', reason: 'envelope_unsupported_version' };
  }
  if (!isPlainObject(writes.fields)) {
    return { kind: 'failed', reason: 'envelope_unparseable' };
  }
  return { kind: 'ok', fields: writes.fields };
}

/** Adds `parsed`'s own entries to `candidates`, honouring the distinct-key cap. */
function collectFields(
  parsed: Record<string, unknown>,
  candidates: Map<string, unknown>,
  failures: ExtractedCustomFieldWrites['failures'],
): void {
  for (const [key, value] of Object.entries(parsed)) {
    if (FORBIDDEN_KEYS.has(key)) {
      failures.push({ reason: 'forbidden_key', sample: key });
      continue;
    }
    if (candidates.size >= MAX_MARKER_KEYS && !candidates.has(key)) {
      failures.push({ reason: 'too_many_keys', sample: key });
      continue;
    }
    candidates.set(key, value);
  }
}

export function extractCustomFieldWrites(
  stdout: string | undefined,
  resultEnvelope: unknown,
): ExtractedCustomFieldWrites {
  const failures: ExtractedCustomFieldWrites['failures'] = [];
  const candidates = new Map<string, unknown>();

  const envelope = readEnvelope(resultEnvelope);
  if (envelope.kind === 'ok') {
    collectFields(envelope.fields, candidates, failures);
    return { candidates, failures, channel: 'envelope' };
  }
  if (envelope.kind === 'failed') {
    // Reported rather than swallowed — a version-skewed agent must not look
    // identical to a script with nothing to say. We still fall through to the
    // stdout marker below: during a fleet rollout an agent may emit both, and
    // a channel the API DOES understand beats refusing the write outright.
    failures.push({ reason: envelope.reason, sample: 'customFieldWrites' });
  }

  if (!stdout || !stdout.includes(CUSTOM_FIELD_MARKER)) {
    // No usable stdout either. If the envelope announced itself and failed,
    // that failure is the whole story and the channel is 'envelope'.
    return {
      candidates,
      failures,
      channel: envelope.kind === 'failed' ? 'envelope' : 'none',
    };
  }

  let lineCount = 0;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith(CUSTOM_FIELD_MARKER)) continue;

    if (lineCount >= MAX_MARKER_LINES) {
      failures.push({ reason: 'too_many_lines', sample: sample(line) });
      continue;
    }
    lineCount += 1;

    const payload = line.slice(CUSTOM_FIELD_MARKER.length).trim();
    if (Buffer.byteLength(payload, 'utf8') > MAX_MARKER_JSON_BYTES) {
      failures.push({ reason: 'marker_too_large', sample: sample(payload) });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      failures.push({ reason: 'marker_unparseable', sample: sample(payload) });
      continue;
    }
    if (!isPlainObject(parsed)) {
      failures.push({ reason: 'marker_unparseable', sample: sample(payload) });
      continue;
    }

    collectFields(parsed, candidates, failures);
  }

  return {
    candidates,
    failures,
    channel: candidates.size > 0 || failures.length > 0 ? 'stdout' : 'none',
  };
}
