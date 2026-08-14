import { z } from 'zod';

// Shared http(s)-only URL guard for tenant-authored URL fields (#3430).
//
// These are values a partner admin types into a settings form and that the
// product later either renders (`partners.billing_website` → the seller block
// on branded invoices, quotes and PDFs) or dials outbound (Slack webhook,
// Elasticsearch endpoint). Neither class has a legitimate custom-scheme use,
// so both get the same narrow allowlist: `http:` and `https:`, nothing else.
//
// SCOPE: this is a scheme guard, NOT an SSRF control. `http://localhost:9200`
// and link-local addresses still pass, deliberately — self-hosted deployments
// legitimately point the Elasticsearch endpoint at them. Anything that needs
// egress restrictions has to add them separately.
//
// Contrast with `remoteAccessLauncherScheme.ts`, which deliberately keeps a
// WIDER, denylist-backed rule because partners genuinely need `rustdesk:` and
// other custom protocol handlers there. That file is the exception; this one is
// the default for anything shaped like a plain web address.
//
// Reject rather than silently strip — a field the server quietly cleared looks
// to the user like the save failed (#3430).

/** Max length accepted by {@link httpUrlValue} unless a caller narrows it. */
export const HTTP_URL_MAX_LENGTH = 2000;

/**
 * True when `value` parses as an absolute URL whose scheme is `http` or
 * `https`. Empty string is NOT accepted here — clearability is a schema-level
 * concern, expressed by {@link httpUrlField}.
 *
 * `new URL()` is the parser on purpose: it normalises the odd-but-legal forms
 * (`HTTP://`, `java\nscript:`) that a hand-rolled regex on the raw string
 * mishandles.
 */
export function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:';
}

/** Human-readable rejection message, shared by the API schemas and the web forms. */
export function httpUrlErrorMessage(label: string): string {
  return `${label} must be a full http:// or https:// URL`;
}

/**
 * Required-shaped http(s) URL string. Empty string is accepted so a field can
 * be cleared without tripping the scheme check.
 */
export function httpUrlValue(label: string, maxLength: number = HTTP_URL_MAX_LENGTH) {
  return z
    .string()
    .max(maxLength)
    .refine((v) => v === '' || isHttpUrl(v), httpUrlErrorMessage(label));
}

/** Optional/clearable form of {@link httpUrlValue}, for standalone fields. */
export function httpUrlField(label: string, maxLength: number = HTTP_URL_MAX_LENGTH) {
  return httpUrlValue(label, maxLength).optional().or(z.literal(''));
}

/**
 * Nullable + optional form, for settings columns that store `NULL` to mean
 * "unset" (the billing/seller profile fields).
 */
export function nullableHttpUrlField(label: string, maxLength: number = HTTP_URL_MAX_LENGTH) {
  return httpUrlValue(label, maxLength).nullable().optional();
}
