// Parses error response bodies returned by the API. Shapes handled: the
// shared zValidator wrapper's `{error: string, details}` (every validation
// 400 since #2201 — apps/api/src/lib/validation.ts), a plain
// `{error: string}`, a plain `details: string[]` from hand-rolled route
// validators, Hono's default `{message: string}`, and the legacy
// pre-#2201 raw zod-validator `{error: {issues: [...]}}` / serialized
// ZodError bodies (kept defensively for older deployed APIs).
// Falling back to `new Error(obj)` produces `[object Object]` in the UI;
// this function picks the most readable rendering of whatever we got.

type ZodIssue = { message?: string; path?: Array<string | number> };

function joinZodIssues(issues: unknown): string | null {
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const messages = issues
    .map((issue) => {
      if (!issue || typeof issue !== 'object') return null;
      const m = (issue as ZodIssue).message;
      return typeof m === 'string' && m.length > 0 ? m : null;
    })
    .filter((m): m is string => m !== null);
  return messages.length > 0 ? messages.join('; ') : null;
}

// Words that read wrong when sentence-cased ("Slack webhook url").
const FIELD_ACRONYMS: Record<string, string> = {
  ai: 'AI', api: 'API', cidr: 'CIDR', cve: 'CVE', dns: 'DNS', html: 'HTML', http: 'HTTP',
  https: 'HTTPS', id: 'ID', ids: 'IDs', ip: 'IP', ips: 'IPs', json: 'JSON', mfa: 'MFA', os: 'OS',
  rpo: 'RPO', rto: 'RTO', sms: 'SMS', smtp: 'SMTP', ssh: 'SSH', ssl: 'SSL', sso: 'SSO', tls: 'TLS',
  totp: 'TOTP', ttl: 'TTL', uri: 'URI', url: 'URL', urls: 'URLs', vpn: 'VPN',
};

/**
 * Turns a zod field path from the API's validation 400
 * (`settings.contact.email`, `contacts.0.email`) into a readable field name
 * (`Email`): the last non-index segment, split on camelCase/snake_case and
 * sentence-cased (#8369). A trailing `Cents` is dropped — money fields are
 * entered in dollars on every form, so `monthlyBudgetCents` is "Monthly
 * budget", matching the label the user actually sees.
 *
 * English-only by construction (it derives from the schema key, not a
 * translation); still far closer to the form label than a JSON path.
 */
export function humanizeFieldPath(path: string): string {
  const segments = path.split('.').filter((s) => s.length > 0 && !/^\d+$/.test(s));
  const leaf = segments.at(-1);
  if (!leaf) return path;
  const base = leaf.replace(/^(.+?)(?:Cents|_cents)$/, '$1');
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter((w) => w.length > 0)
    .map((w) => FIELD_ACRONYMS[w.toLowerCase()] ?? w.toLowerCase());
  if (words.length === 0) return path;
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  return words.join(' ');
}

// "Email: Invalid email address" — but not "Slack webhook URL: Slack webhook
// URL must be …" when the message already names the field.
function labelFieldMessage(field: string, message: string): string {
  const label = humanizeFieldPath(field);
  const lowerMessage = message.toLowerCase();
  const lowerLabel = label.toLowerCase();
  if (lowerMessage.startsWith(lowerLabel) && !/[a-z]/i.test(message.charAt(label.length))) {
    return message;
  }
  return `${label}: ${message}`;
}

// Renders a zod flatten payload ({formErrors: string[], fieldErrors:
// Record<string, string[]>}) — emitted as `details` by every zValidator 400
// via the shared wrapper (apps/api/src/lib/validation.ts, #2201) and by some
// route validators (e.g. configuration-policy feature links).
//
// `rawPaths` reproduces the wrapper's own `error` string byte-for-byte (same
// ordering and '; ' join, dotted JSON paths), which is how extractApiError
// recognises that `error` is just the developer rendering of these details.
// The default renders readable field labels instead (#8369).
function joinZodFlatten(value: unknown, rawPaths = false): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { formErrors, fieldErrors } = value as { formErrors?: unknown; fieldErrors?: unknown };
  const parts: string[] = [];
  if (Array.isArray(formErrors)) {
    for (const m of formErrors) {
      if (typeof m === 'string' && m.length > 0) parts.push(m);
    }
  }
  if (fieldErrors && typeof fieldErrors === 'object' && !Array.isArray(fieldErrors)) {
    for (const [field, messages] of Object.entries(fieldErrors as Record<string, unknown>)) {
      if (!Array.isArray(messages)) continue;
      const valid = messages.filter((m): m is string => typeof m === 'string' && m.length > 0);
      if (valid.length === 0) continue;
      const joined = valid.join('; ');
      parts.push(rawPaths ? `${field}: ${joined}` : labelFieldMessage(field, joined));
    }
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

// Renders a `details` ARRAY in ONE pass, accepting both representations an
// entry can take: a plain message string (what hand-rolled route validators
// emit, e.g. the notification-channel create's `{ error: 'Invalid webhook
// channel configuration', details: ['Webhook URL must use HTTPS', ...] }`) and
// a zod-style object carrying `.message`.
//
// One pass rather than two branches, because trying `joinZodIssues` first and
// falling back to a string-only join DROPS HALF of a mixed array: the first
// branch returns as soon as any object has a `.message`, so
// `[{ message: 'name is required' }, 'Webhook URL must use HTTPS']` rendered
// only the object's message and silently discarded the string. Nothing
// guarantees a route emits a homogeneous array, and dropping a reason is the
// exact failure this whole change exists to remove.
//
// Equivalent to the old zod-issues path for a pure-object array: joinZodIssues
// reads ONLY `.message` (it ignores `path`), so an all-objects array renders
// identically here.
function collectMessageArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const messages = value
    .map((entry) => {
      if (typeof entry === 'string') return entry.length > 0 ? entry : null;
      if (entry && typeof entry === 'object') {
        const m = (entry as ZodIssue).message;
        return typeof m === 'string' && m.length > 0 ? m : null;
      }
      return null;
    })
    .filter((m): m is string => m !== null);
  return messages.length > 0 ? messages : null;
}

/**
 * `exclude` holds the message parts already chosen (currently the top-level
 * `error`). Array details are de-duplicated PER MESSAGE against it, not as one
 * joined blob: comparing the whole joined string only dedupes when EVERY
 * detail repeats the top-level error, so
 * `{ error: 'name is required', details: [{ message: 'name is required' },
 * 'Webhook URL must use HTTPS'] }` rendered the first message twice.
 */
function detailsToString(details: unknown, exclude: readonly string[]): string | null {
  if (typeof details === 'string' && details.length > 0) {
    return exclude.includes(details) ? null : details;
  }
  // Handles zod issue objects AND plain strings in the same array — see
  // collectMessageArray for why these are not two ordered branches.
  const messages = collectMessageArray(details);
  if (messages) {
    // Two dedup rules, because each alone regresses a real shape:
    //
    //   per-message — `{ error: 'name is required', details: [{message:'name
    //   is required'}, 'Webhook URL must use HTTPS'] }` must not echo the
    //   first message; comparing only the JOINED string never matches here.
    //
    //   whole-string — `{ error: 'a; b', details: [{message:'a'},
    //   {message:'b'}] }` is the SAME text split up; no individual message
    //   equals the aggregate, so per-message alone renders it all twice.
    //
    // Removing at most one occurrence per excluded part (rather than every
    // match) keeps a repeat that a second, distinct failure produced.
    const remaining = [...exclude];
    const fresh = messages.filter((m) => {
      const i = remaining.indexOf(m);
      if (i === -1) return true;
      remaining.splice(i, 1);
      return false;
    });
    if (fresh.length === 0) return null;
    const joined = fresh.join('; ');
    return exclude.includes(joined) ? null : joined;
  }
  const fromFlatten = joinZodFlatten(details);
  if (fromFlatten) return exclude.includes(fromFlatten) ? null : fromFlatten;
  return null;
}

export function extractApiError(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback;
  const body = data as { error?: unknown; details?: unknown; message?: unknown };

  // Top-level zod issues from raw zValidator result (rare but possible).
  const topLevelIssues = joinZodIssues((data as { issues?: unknown }).issues);

  const parts: string[] = [];

  if (typeof body.error === 'string' && body.error.length > 0) {
    // The shared zValidator wrapper's `error` is the dotted-path rendering of
    // the same flatten `details` (apps/api/src/lib/validation.ts). Skip it so
    // the details render once, with readable field labels (#8369). Any other
    // `error` (a route's own headline) is kept.
    if (body.error !== joinZodFlatten(body.details, true)) parts.push(body.error);
  } else if (body.error && typeof body.error === 'object') {
    const errObj = body.error as { issues?: unknown; message?: unknown; name?: unknown };
    let fromError = joinZodIssues(errObj.issues);
    // Legacy pre-#2201 path (kept defensively for older deployed APIs):
    // zod v4 ZodError.issues is a NON-enumerable property, so JSON.stringify
    // drops it and the issues array is JSON-stringified into error.message
    // instead. @hono/zod-validator's default 400 hook emitted the bare
    // ZodError, so recover the issues from the message to keep validation
    // text in the UI.
    if (!fromError && errObj.name === 'ZodError' && typeof errObj.message === 'string') {
      try {
        fromError = joinZodIssues(JSON.parse(errObj.message));
      } catch {
        // message wasn't a JSON issues array — leave fromError null
      }
    }
    if (fromError) parts.push(fromError);
  }

  const fromDetails = detailsToString(body.details, parts);
  if (fromDetails) parts.push(fromDetails);

  if (parts.length === 0 && topLevelIssues) parts.push(topLevelIssues);

  if (parts.length === 0 && typeof body.message === 'string' && body.message.length > 0) {
    parts.push(body.message);
  }

  // Some legacy endpoints (remote/proxy tunnel) emit `errorMessage` instead.
  if (parts.length === 0) {
    const errorMessage = (data as { errorMessage?: unknown }).errorMessage;
    if (typeof errorMessage === 'string' && errorMessage.length > 0) {
      parts.push(errorMessage);
    }
  }

  if (parts.length === 0 && data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const tr = d.testResult as { message?: unknown } | undefined;
    if (tr && typeof tr === 'object' && typeof tr.message === 'string' && tr.message.trim()) {
      return tr.message;
    }
  }

  return parts.length > 0 ? parts.join(': ') : fallback;
}

export function isApiFailure(data: unknown, httpStatus: number): boolean {
  if (httpStatus >= 400) return true;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (d.success === false) return true;
    const tr = d.testResult as { success?: unknown } | undefined;
    if (tr && typeof tr === 'object' && tr.success === false) return true;
  }
  return false;
}
