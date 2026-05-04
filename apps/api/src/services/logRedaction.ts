const REDACTED = '[REDACTED]';

const SECRET_KEY_PATTERN = /password|passwd|pwd|token|secret|api.*key|access.*key|private.*key|client.*secret|authorization|cookie|session|credential|community|authpassphrase|privacypassphrase/i;

const SECRET_ASSIGNMENT_PATTERNS: RegExp[] = [
  /\b(authorization\s*:\s*bearer\s+)[^\s,;]+/gi,
  /\b((?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|community|authpassphrase|privacypassphrase)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
  /\b(Cookie\s*:\s*)[^\r\n]+/g,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function redactLogMessage(message: string): string {
  return SECRET_ASSIGNMENT_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, (_match, prefix) => `${prefix}${REDACTED}`),
    message
  );
}

export function redactLogFields(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;

  if (Array.isArray(value)) {
    return value.map((entry) => redactLogFields(entry, depth + 1));
  }

  if (!isRecord(value)) {
    return typeof value === 'string' ? redactLogMessage(value) : value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = isSecretKey(key) ? REDACTED : redactLogFields(entry, depth + 1);
  }
  return redacted;
}

export function redactAgentLogRow<T extends { message?: unknown; fields?: unknown }>(row: T): T {
  return {
    ...row,
    message: typeof row.message === 'string' ? redactLogMessage(row.message) : row.message,
    fields: row.fields == null ? row.fields : redactLogFields(row.fields),
  };
}
