import { createHash } from 'node:crypto';
import { redactLogFields, redactLogMessage } from './logRedaction';

const REDACTED = '[REDACTED]';
const DEFAULT_MAX_STRING_LENGTH = 2048;
const DEFAULT_MAX_DEPTH = 8;
const SECRET_FIELD_PATTERN = /^(password|passwd|pwd|token|secret|authorization|cookie|credential|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|community|authpassphrase|privacypassphrase)$/i;
const RAW_CONTENT_FIELD_PATTERN = /^(content|body|stdin|scriptContent|fileContent)$/i;

export interface SanitizePayloadOptions {
  maxStringLength?: number;
  maxDepth?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function capString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...[TRUNCATED length=${value.length}]`;
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sanitizeAuditPayload(value: unknown, options: SanitizePayloadOptions = {}, depth = 0): unknown {
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  if (depth > maxDepth) {
    return REDACTED;
  }

  if (typeof value === 'string') {
    return capString(value, maxStringLength);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeAuditPayload(entry, options, depth + 1));
  }

  if (!isRecord(value)) {
    return value;
  }

  const redactedByKey = redactLogFields(value);
  if (!isRecord(redactedByKey)) {
    return redactedByKey;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(redactedByKey)) {
    if (SECRET_FIELD_PATTERN.test(key)) {
      sanitized[key] = REDACTED;
      continue;
    }
    if (RAW_CONTENT_FIELD_PATTERN.test(key)) {
      sanitized[key] = typeof entry === 'string'
        ? { redacted: true, length: entry.length, sha256: hashString(entry) }
        : REDACTED;
      continue;
    }
    sanitized[key] = sanitizeAuditPayload(entry, options, depth + 1);
  }
  return sanitized;
}

export function summarizePayload(value: unknown, options: SanitizePayloadOptions = {}): Record<string, unknown> {
  if (!isRecord(value)) {
    return { valueType: value === null ? 'null' : typeof value };
  }

  const targetKeys = [
    'orgId',
    'deviceId',
    'deviceIds',
    'siteId',
    'scriptId',
    'executionId',
    'commandId',
    'policyId',
    'alertId',
    'ticketId',
    'path',
    'hostname',
  ];
  const summary: Record<string, unknown> = {};
  for (const key of targetKeys) {
    if (value[key] !== undefined) {
      summary[key] = sanitizeAuditPayload(value[key], options);
    }
  }
  summary.argKeys = Object.keys(value).sort();
  return summary;
}

export function summarizeToolResult(result: string, options: SanitizePayloadOptions = {}): Record<string, unknown> {
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  const metadata: Record<string, unknown> = {
    resultBytes: Buffer.byteLength(result, 'utf8'),
    resultSha256: hashString(result),
  };

  try {
    const parsed = JSON.parse(result);
    if (isRecord(parsed)) {
      metadata.resultKeys = Object.keys(parsed).sort();
      if (typeof parsed.error === 'string') {
        metadata.error = capString(redactLogMessage(parsed.error), Math.min(maxStringLength, 500));
      }
      if (typeof parsed.status === 'string') {
        metadata.status = capString(parsed.status, 100);
      }
      if (typeof parsed.imageBase64 === 'string') {
        metadata.containsImage = true;
      }
      return metadata;
    }
  } catch {
    // Non-JSON tool output is expected for some tools.
  }

  metadata.resultType = 'text';
  return metadata;
}
