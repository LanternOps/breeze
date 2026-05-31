const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:']);

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

export function getSafeHttpHref(
  value: string | null | undefined,
  baseHref?: string,
  allowedOriginsConfig?: string,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith('//') || /[\u0000-\u001F\u007F]/.test(trimmed)) {
    return null;
  }

  try {
    const base = baseHref ?? (typeof window !== 'undefined' ? window.location.href : 'http://localhost/');
    const url = new URL(trimmed, base);
    if (!SAFE_LINK_PROTOCOLS.has(url.protocol) || url.username || url.password) {
      return null;
    }

    if (!/^[a-z][a-z\d+.-]*:/i.test(trimmed) && !trimmed.startsWith('/')) {
      return null;
    }

    const baseUrl = new URL(base);
    const allowedOrigins = parseAllowedOrigins(
      allowedOriginsConfig ?? import.meta.env.PUBLIC_RECORDING_URL_ALLOWED_ORIGINS,
    );
    allowedOrigins.add(baseUrl.origin);
    if (!allowedOrigins.has(url.origin)) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

/**
 * Scheme-only guard for intentionally external links (e.g. vendor homepage URLs).
 *
 * Unlike {@link getSafeHttpHref}, this does NOT constrain the origin — any
 * http(s) origin is permitted. It only ensures the value is an absolute URL
 * with a safe scheme and no embedded credentials, so a hostile value can never
 * turn into a `javascript:`/`data:`/`vbscript:` href or a credentials-leaking
 * link. Returns the normalized href, or null if the value is unsafe.
 */
export function getSafeExternalHref(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith('//') || /[\u0000-\u001F\u007F]/.test(trimmed)) {
    return null;
  }

  try {
    // No base: external links must be absolute URLs.
    const url = new URL(trimmed);
    if (!SAFE_LINK_PROTOCOLS.has(url.protocol) || url.username || url.password) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}
