/**
 * AI Input Sanitizer
 *
 * Detects and strips prompt injection patterns, dangerous Unicode,
 * and enforces input limits for AI chat messages and page context.
 */

// Page context types (mirror aiAgent.ts)
type AiPageContext =
  | { type: 'device'; id: string; hostname: string; os?: string; status?: string; ip?: string }
  | { type: 'alert'; id: string; title: string; severity?: string; deviceHostname?: string }
  | { type: 'dashboard'; orgName?: string; deviceCount?: number; alertCount?: number }
  | { type: 'custom'; label: string; data: Record<string, unknown> };

export interface SanitizeResult {
  sanitized: string;
  flags: string[];
}

const MAX_MESSAGE_LENGTH = 10_000;

// Prompt injection patterns (use `giu` flags for Unicode-aware matching)
const INJECTION_PATTERNS: Array<{ pattern: RegExp; flag: string }> = [
  // Role impersonation
  { pattern: /\b(Human|Assistant|System)\s*:/giu, flag: 'role_impersonation' },
  { pattern: /<\|im_start\|>/giu, flag: 'chatml_injection' },
  { pattern: /<\|im_end\|>/giu, flag: 'chatml_injection' },
  // XML tag injection targeting system instructions
  { pattern: /<\/?system>/giu, flag: 'xml_system_tag' },
  { pattern: /<\/?instructions>/giu, flag: 'xml_instructions_tag' },
  { pattern: /<\/?prompt>/giu, flag: 'xml_prompt_tag' },
  { pattern: /<\/?context>/giu, flag: 'xml_context_tag' },
  // System prompt override attempts
  { pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|prompts)/giu, flag: 'override_attempt' },
  { pattern: /forget\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|prompts)/giu, flag: 'override_attempt' },
  { pattern: /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|prompts)/giu, flag: 'override_attempt' },
  { pattern: /you\s+are\s+now\s+(a|an)\s+/giu, flag: 'role_reassignment' },
  { pattern: /new\s+instructions?\s*:/giu, flag: 'override_attempt' },
  { pattern: /system\s+prompt\s*:/giu, flag: 'override_attempt' },
];

// Dangerous Unicode ranges: bidi overrides, zero-width characters, and zero-width joiners
const DANGEROUS_UNICODE = /[\u200B-\u200F\u200D\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD\u00A0]/gu;

/**
 * Sanitize a user message before sending to the AI model.
 * Strips injection patterns and dangerous Unicode, enforces length limit.
 */
export function sanitizeUserMessage(content: string): SanitizeResult {
  const flags: string[] = [];
  let sanitized = content;

  // Enforce max length
  if (sanitized.length > MAX_MESSAGE_LENGTH) {
    sanitized = sanitized.slice(0, MAX_MESSAGE_LENGTH);
    flags.push('truncated');
  }

  // Strip dangerous Unicode (compare before/after to avoid global regex lastIndex bug)
  const beforeUnicode = sanitized;
  sanitized = sanitized.replace(DANGEROUS_UNICODE, '');
  if (sanitized !== beforeUnicode) {
    flags.push('dangerous_unicode');
  }

  // Detect and strip injection patterns
  for (const { pattern, flag } of INJECTION_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    if (pattern.test(sanitized)) {
      if (!flags.includes(flag)) {
        flags.push(flag);
      }
      pattern.lastIndex = 0;
      sanitized = sanitized.replace(pattern, '[filtered]');
    }
  }

  return { sanitized, flags };
}

/**
 * Sanitize page context before including in system prompt.
 * Truncates fields and strips injection patterns from string values.
 *
 * Return shape stays `AiPageContext` for backward compatibility. Callers that
 * want to observe whether anything was neutralized (so an injection attempt via
 * page context is recorded rather than silently dropped — mirroring
 * `sanitizeUserMessage`'s flags) should pass a `flags` collector array; any
 * detected flags are appended to it in place.
 */
export function sanitizePageContext(ctx: AiPageContext, flags?: string[]): AiPageContext {
  const clone = structuredClone(ctx);
  const sink = flags ?? [];

  switch (clone.type) {
    case 'device':
      clone.hostname = sanitizeField(clone.hostname, 255, sink);
      if (clone.os) clone.os = sanitizeField(clone.os, 100, sink);
      if (clone.status) clone.status = sanitizeField(clone.status, 50, sink);
      if (clone.ip) clone.ip = sanitizeField(clone.ip, 45, sink);
      break;

    case 'alert':
      clone.title = sanitizeField(clone.title, 500, sink);
      if (clone.severity) clone.severity = sanitizeField(clone.severity, 50, sink);
      if (clone.deviceHostname) clone.deviceHostname = sanitizeField(clone.deviceHostname, 255, sink);
      break;

    case 'dashboard':
      if (clone.orgName) clone.orgName = sanitizeField(clone.orgName, 255, sink);
      break;

    case 'custom':
      clone.label = sanitizeField(clone.label, 200, sink);
      clone.data = sanitizeRecord(clone.data, sink);
      break;
  }

  return clone;
}

function addFlag(flags: string[], flag: string): void {
  if (!flags.includes(flag)) flags.push(flag);
}

function sanitizeField(value: string, maxLength: number, flags: string[] = []): string {
  let sanitized = value.slice(0, maxLength);
  const beforeUnicode = sanitized;
  sanitized = sanitized.replace(DANGEROUS_UNICODE, '');
  if (sanitized !== beforeUnicode) addFlag(flags, 'dangerous_unicode');
  for (const { pattern, flag } of INJECTION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(sanitized)) {
      addFlag(flags, flag);
      pattern.lastIndex = 0;
      sanitized = sanitized.replace(pattern, '[filtered]');
    }
  }
  return sanitized;
}

function sanitizeRecord(data: Record<string, unknown>, flags: string[] = []): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    let safeKey = sanitizeField(key, 200, flags);
    // Distinct injection-shaped keys can collapse to the same sanitized string
    // (e.g. both become "[filtered]"), which would silently overwrite the first
    // value. Disambiguate with a numeric suffix so no value is dropped, and flag
    // that a collision occurred.
    if (safeKey in result) {
      addFlag(flags, 'key_collision');
      let suffix = 2;
      while (`${safeKey}_${suffix}` in result) suffix++;
      safeKey = `${safeKey}_${suffix}`;
    }
    result[safeKey] = sanitizeContextValue(value, flags);
  }
  return result;
}

function sanitizeContextValue(value: unknown, flags: string[] = []): unknown {
  if (typeof value === 'string') {
    return sanitizeField(value, 1000, flags);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeContextValue(entry, flags));
  }
  if (typeof value === 'object' && value !== null) {
    return sanitizeRecord(value as Record<string, unknown>, flags);
  }
  return value;
}
