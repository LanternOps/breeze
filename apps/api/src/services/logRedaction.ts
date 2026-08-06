const REDACTED = '[REDACTED]';

const SECRET_KEY_PATTERN = /password|passwd|pwd|token|secret|api.*key|access.*key|private.*key|client.*secret|authorization|cookie|session|credential|community|authpassphrase|privacypassphrase|connection.?string|conn.?string|sas.?token|shared.?key/i;

const SECRET_ASSIGNMENT_PATTERNS: RegExp[] = [
  /\b(authorization\s*:\s*bearer\s+)[^\s,;]+/gi,
  // Includes `auth=` to catch Pi-hole's URL pattern `?auth=<apiKey>` —
  // these can leak into Node fetch error messages whose .cause echoes
  // the URL verbatim.
  /\b((?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|community|authpassphrase|privacypassphrase|auth)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
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
    const redactedEntry = isSecretKey(key) ? REDACTED : redactLogFields(entry, depth + 1);

    // `redacted[key] = …` for the literal key `__proto__` does NOT create an own
    // property — it invokes the setter inherited from Object.prototype (#3129):
    //   * object value    -> the key vanishes from the output AND the returned
    //                        object's prototype is silently replaced, so it
    //                        inherits whatever the agent sent.
    //   * primitive value -> the key vanishes, silently.
    // Either way the field is lost from redacted logs; the object case also
    // reprototypes an object built from untrusted input. defineProperty writes a
    // real own property and leaves the prototype alone, so the field survives
    // under its true name and JSON.stringify round-trips it unchanged.
    if (key === '__proto__') {
      Object.defineProperty(redacted, key, {
        value: redactedEntry,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      continue;
    }

    redacted[key] = redactedEntry;
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
