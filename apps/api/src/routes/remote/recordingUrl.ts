const SAFE_RECORDING_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_RECORDING_URL_LENGTH = 2048;

function parseAllowedOrigins(configuredOrigins: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const origin of configuredOrigins?.split(',') ?? []) {
    const trimmed = origin.trim();
    if (!trimmed) continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      // Ignore invalid origin configuration.
    }
  }
  return origins;
}

export function normalizeRecordingUrl(
  value: unknown,
  options: { requestOrigin?: string; allowedOrigins?: string } = {},
): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error('recordingUrl must be a string');
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (
    trimmed.length > MAX_RECORDING_URL_LENGTH ||
    trimmed.startsWith('//') ||
    /[\u0000-\u001F\u007F]/.test(trimmed)
  ) {
    throw new Error('recordingUrl must be an http(s) URL or same-origin path');
  }

  try {
    if (trimmed.startsWith('/')) {
      new URL(trimmed, 'https://breeze.local');
      return trimmed;
    }

    const parsed = new URL(trimmed);
    if (!SAFE_RECORDING_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('unsafe recording URL');
    }
    const allowedOrigins = parseAllowedOrigins(
      options.allowedOrigins ?? process.env.RECORDING_URL_ALLOWED_ORIGINS,
    );
    if (options.requestOrigin) {
      allowedOrigins.add(new URL(options.requestOrigin).origin);
    }
    if (!allowedOrigins.has(parsed.origin)) {
      throw new Error('disallowed recording URL origin');
    }
    return parsed.toString();
  } catch {
    throw new Error('recordingUrl must be a same-origin path or allowed http(s) origin');
  }
}
