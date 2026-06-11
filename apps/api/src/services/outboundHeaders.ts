const RFC_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

const RESERVED_OUTBOUND_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'content-type',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent'
]);

export function validateOutboundHeader(name: string, value: string): string | null {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return 'Header name is required';
  }

  if (!RFC_TOKEN_RE.test(trimmedName)) {
    return `Header "${trimmedName}" must be a valid RFC token`;
  }

  if (CONTROL_CHARS_RE.test(trimmedName) || CONTROL_CHARS_RE.test(value)) {
    return `Header "${trimmedName}" cannot contain control characters`;
  }

  const normalized = trimmedName.toLowerCase();
  if (RESERVED_OUTBOUND_HEADERS.has(normalized) || normalized.startsWith('x-breeze-')) {
    return `Header "${trimmedName}" is reserved`;
  }

  return null;
}

export function getOutboundHeaderValidationErrors(headers: Record<string, string> | Array<{ key: string; value: string }>): string[] {
  const entries = Array.isArray(headers)
    ? headers.map((header) => [header.key, header.value] as const)
    : Object.entries(headers);

  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    const error = validateOutboundHeader(name, value);
    if (error) {
      errors.push(error);
      continue;
    }

    const normalized = name.trim().toLowerCase();
    if (seen.has(normalized)) {
      errors.push(`Header "${name.trim()}" is duplicated`);
      continue;
    }
    seen.add(normalized);
  }

  return errors;
}

export function sanitizeOutboundHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value !== 'string') continue;
    if (validateOutboundHeader(name, value)) continue;
    sanitized[name.trim()] = value;
  }
  return sanitized;
}
