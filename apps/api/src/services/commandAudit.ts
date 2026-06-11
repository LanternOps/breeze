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

export function sanitizeCommandResultForHistory(result: CommandResult | null | undefined): unknown {
  if (!isRecord(result)) return result ?? null;
  const sanitized = sanitizeAuditPayload(result, { maxStringLength: 4096 });

  return {
    ...(isRecord(sanitized) ? sanitized : {}),
    stdout: typeof result.stdout === 'string' ? `${REDACTED}: stdout omitted from command history` : result.stdout,
    stderr: typeof result.stderr === 'string' ? `${REDACTED}: stderr omitted from command history` : result.stderr,
  };
}

export function sanitizeCommandForHistory<T extends { type: string; payload?: unknown; result?: unknown }>(command: T): T {
  return {
    ...command,
    payload: sanitizeCommandPayloadForAudit(command.type, command.payload as CommandPayload | null | undefined),
    result: sanitizeCommandResultForHistory(command.result as CommandResult | null | undefined),
  } as T;
}
