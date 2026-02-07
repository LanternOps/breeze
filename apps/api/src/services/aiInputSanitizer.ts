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
 */
export function sanitizePageContext(ctx: AiPageContext): AiPageContext {
  const clone = structuredClone(ctx);

  switch (clone.type) {
    case 'device':
      clone.hostname = sanitizeField(clone.hostname, 255);
      if (clone.os) clone.os = sanitizeField(clone.os, 100);
      if (clone.status) clone.status = sanitizeField(clone.status, 50);
      if (clone.ip) clone.ip = sanitizeField(clone.ip, 45);
      break;

    case 'alert':
      clone.title = sanitizeField(clone.title, 500);
      if (clone.severity) clone.severity = sanitizeField(clone.severity, 50);
      if (clone.deviceHostname) clone.deviceHostname = sanitizeField(clone.deviceHostname, 255);
      break;

    case 'dashboard':
      if (clone.orgName) clone.orgName = sanitizeField(clone.orgName, 255);
      break;

    case 'custom':
      clone.label = sanitizeField(clone.label, 200);
      clone.data = sanitizeRecord(clone.data);
      break;
  }

  return clone;
}

function sanitizeField(value: string, maxLength: number): string {
  let sanitized = value.slice(0, maxLength);
  sanitized = sanitized.replace(DANGEROUS_UNICODE, '');
  for (const { pattern } of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[filtered]');
  }
  return sanitized;
}

function sanitizeRecord(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      result[key] = sanitizeField(value, 1000);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = sanitizeRecord(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
