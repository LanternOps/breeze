import { createHash } from 'node:crypto';
import type { CommandPayload, CommandResult } from './commandQueue';
import { sanitizeAuditPayload } from './auditPayloadSanitizer';

const REDACTED = '[REDACTED]';
const FILE_WRITE = 'file_write';
const SCRIPT = 'script';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function contentMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return { redacted: true, present: value !== undefined };
  }

  return {
    redacted: true,
    length: value.length,
    sizeBytes: Buffer.byteLength(value, 'utf8'),
    sha256: createHash('sha256').update(value).digest('hex'),
  };
}

export function sanitizeCommandPayloadForAudit(type: string, payload: CommandPayload | null | undefined): unknown {
  if (!isRecord(payload)) {
    return payload ?? null;
  }

  if (type === FILE_WRITE) {
    return {
      path: sanitizeAuditPayload(payload.path),
      encoding: sanitizeAuditPayload(payload.encoding),
      append: payload.append,
      mode: payload.mode,
      content: contentMetadata(payload.content ?? payload.data),
    };
  }

  if (type === SCRIPT) {
    return {
      scriptId: sanitizeAuditPayload(payload.scriptId),
      executionId: sanitizeAuditPayload(payload.executionId),
      batchId: sanitizeAuditPayload(payload.batchId),
      language: sanitizeAuditPayload(payload.language),
      timeoutSeconds: payload.timeoutSeconds,
      runAs: sanitizeAuditPayload(payload.runAs),
      content: contentMetadata(payload.content),
      parameters: sanitizeAuditPayload(payload.parameters),
    };
  }

  return sanitizeAuditPayload(payload);
}

export function commandAuditDetails(
  commandId: string,
  type: string,
  payload: CommandPayload | null | undefined,
): Record<string, unknown> {
  return {
    commandId,
    type,
    payload: sanitizeCommandPayloadForAudit(type, payload),
  };
}

/**
 * Command types whose result stdout is a machine artifact with no tenant or
 * secret content, and whose only delivery channel IS the stored command
 * result. `capture_pprof` stdout is JSON carrying base64 gzip-protobuf Go
 * runtime profiles of the agent's own process (heap allocation sites /
 * goroutine stacks of our binary) — nothing user-generated to leak, and
 * redacting it would make the profiles unretrievable (#2401).
 *
 * String literal (not CommandTypes.CAPTURE_PPROF) on purpose: commandQueue.ts
 * imports this module, so a value import back into commandQueue would create
 * a runtime import cycle.
 */
const RAW_STDOUT_COMMAND_TYPES = new Set(['capture_pprof']);

/**
 * True when a command type's stdout is an opaque machine artifact that must
 * be stored byte-for-byte. Both result-ingest legs (agent WS + REST) use this
 * to skip `redactSecretsFromOutput` on stdout: the secret patterns
 * (case-insensitive AKIA + 16 alnum, etc.) statistically fire inside
 * megabytes of random base64 and would silently corrupt the profile bytes.
 * stderr/error redaction is never skipped.
 */
export function isRawStdoutArtifactCommand(type: string): boolean {
  return RAW_STDOUT_COMMAND_TYPES.has(type);
}

export function sanitizeCommandResultForHistory(
  result: CommandResult | null | undefined,
  opts: { keepRawStdout?: boolean } = {},
): unknown {
  if (!isRecord(result)) return result ?? null;
  const sanitized = sanitizeAuditPayload(result, { maxStringLength: 4096 });

  return {
    ...(isRecord(sanitized) ? sanitized : {}),
    stdout:
      typeof result.stdout === 'string'
        ? opts.keepRawStdout
          ? result.stdout
          : `${REDACTED}: stdout omitted from command history`
        : result.stdout,
    stderr: typeof result.stderr === 'string' ? `${REDACTED}: stderr omitted from command history` : result.stderr,
  };
}

export function sanitizeCommandForHistory<T extends { type: string; payload?: unknown; result?: unknown }>(
  command: T,
  opts: {
    /**
     * Opt-in stdout pass-through, honored only for RAW_STDOUT_COMMAND_TYPES.
     * Only the single-command GET sets this — list endpoints stay redacted so
     * pages of history never balloon by megabytes of base64 per profile row.
     */
    allowRawStdout?: boolean;
  } = {},
): T {
  const keepRawStdout = opts.allowRawStdout === true && RAW_STDOUT_COMMAND_TYPES.has(command.type);
  return {
    ...command,
    payload: sanitizeCommandPayloadForAudit(command.type, command.payload as CommandPayload | null | undefined),
    result: sanitizeCommandResultForHistory(command.result as CommandResult | null | undefined, { keepRawStdout }),
  } as T;
}
