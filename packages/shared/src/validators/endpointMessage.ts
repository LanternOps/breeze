import { z } from 'zod';
import { semverCompare } from '../utils/semverCompare';

/**
 * Endpoint messaging (#8293, W1): a technician pushes a branded, acknowledgeable
 * message to the person at a device. These limits are enforced by the API send
 * route AND re-checked by the Assist helper before rendering (defence in depth),
 * so they live here, in one place.
 */
export const ENDPOINT_MESSAGE_LIMITS = {
  titleMax: 120,
  bodyMax: 2000,
  /** Hard cap on devices resolved by one send. */
  maxDevices: 5000,
  /** A send resolving to more devices than this needs `confirmedCount`. */
  confirmAbove: 100,
  defaultExpiresInMinutes: 1440,
  /** 168 h — the `standard` offline class TTL. `null` ("until closed") is capped here too. */
  maxExpiresInMinutes: 10080,
} as const;

export const ENDPOINT_MESSAGE_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type EndpointMessageSeverity = (typeof ENDPOINT_MESSAGE_SEVERITIES)[number];

/**
 * First agent release whose `notify_user` handler understands the
 * endpoint-message payload (persistent card, ack, native fan-out). An older
 * agent would ignore the extra keys, show a transient toast and report
 * success, so the API never queues a message to an agent below this.
 *
 * Fail-closed placeholder until the release carrying the agent change is cut:
 * no real agent reaches 999.0.0, so nothing is queued.
 */
export const ENDPOINT_MESSAGING_MIN_AGENT_VERSION = '999.0.0';

/** False for null, unparseable and older versions — never guesses in favour. */
export function agentSupportsEndpointMessaging(agentVersion: string | null | undefined): boolean {
  if (typeof agentVersion !== 'string' || agentVersion.trim() === '') return false;
  const cmp = semverCompare(agentVersion.trim(), ENDPOINT_MESSAGING_MIN_AGENT_VERSION);
  return cmp !== null && cmp >= 0;
}

// Any HTML-looking tag: `<b>`, `</b>`, `<img ...>`, `<!-- -->`. A lone `<` or
// `a < b` comparison is fine. Autolinks `<https://…>` are judged by the URL rule.
const HTML_TAG = /<\/?[A-Za-z!][^>]*>/g;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/;
const MARKDOWN_LINK = /\[[^\]]*\]\(\s*([^)\s]*)[^)]*\)/g;
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]*:[^>\s]*)>/g;
// Bare scheme-qualified URLs in prose. `https://` is allowed; any other scheme a
// renderer might linkify (http, javascript, data, file, ftp, mailto…) is not.
const BARE_URL = /\b([A-Za-z][A-Za-z0-9+.-]*):\/\/[^\s)>\]]+/g;
const BARE_DANGEROUS_SCHEME = /\b(?:javascript|data|vbscript|file):/i;

function isHttpsUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname.length > 0;
  } catch {
    return false;
  }
}

function bodyIssues(body: string): string[] {
  const issues: string[] = [];
  if (MARKDOWN_IMAGE.test(body)) issues.push('images are not allowed');
  for (const m of body.matchAll(MARKDOWN_LINK)) {
    if (!isHttpsUrl(m[1] ?? '')) issues.push('links must use https');
  }
  for (const m of body.matchAll(AUTOLINK)) {
    if (!isHttpsUrl(m[1] ?? '')) issues.push('links must use https');
  }
  const withoutAutolinks = body.replace(AUTOLINK, (whole, url: string) => (isHttpsUrl(url) ? '' : whole));
  if (HTML_TAG.test(withoutAutolinks)) issues.push('html is not allowed');
  HTML_TAG.lastIndex = 0;
  for (const m of body.matchAll(BARE_URL)) {
    if ((m[1] ?? '').toLowerCase() !== 'https') issues.push('links must use https');
  }
  if (BARE_DANGEROUS_SCHEME.test(body)) issues.push('links must use https');
  return [...new Set(issues)];
}

/**
 * Content problems with a message, empty when it is acceptable. The title is
 * plain text: no HTML, no markdown links (the card shows it as a heading and a
 * link there would sit next to the fixed sender slot). The body is a restricted
 * markdown subset: https links only, no images, no HTML.
 */
export function endpointMessageContentIssues(title: string, body: string): string[] {
  const issues: string[] = [];
  if (HTML_TAG.test(title)) issues.push('title: html is not allowed');
  HTML_TAG.lastIndex = 0;
  if (/\[[^\]]*\]\([^)]*\)/.test(title) || /[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(title)) {
    issues.push('title: links are not allowed');
  }
  for (const issue of bodyIssues(body)) issues.push(`body: ${issue}`);
  return issues;
}

const uuidList = z.array(z.string().uuid()).max(ENDPOINT_MESSAGE_LIMITS.maxDevices);

export const endpointMessageTargetsSchema = z
  .object({
    deviceIds: uuidList.optional(),
    siteIds: uuidList.optional(),
    deviceGroupIds: uuidList.optional(),
    orgId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (t) =>
      (t.deviceIds?.length ?? 0) + (t.siteIds?.length ?? 0) + (t.deviceGroupIds?.length ?? 0) > 0
      || t.orgId !== undefined,
    { message: 'at least one target is required' },
  );

export const endpointMessageSendSchema = z
  .object({
    /** Client-generated; a retry with the same id never creates a second card. */
    messageId: z.string().uuid(),
    targets: endpointMessageTargetsSchema,
    title: z.string().trim().min(1).max(ENDPOINT_MESSAGE_LIMITS.titleMax),
    body: z.string().trim().min(1).max(ENDPOINT_MESSAGE_LIMITS.bodyMax),
    severity: z.enum(ENDPOINT_MESSAGE_SEVERITIES),
    requiresAck: z.boolean().default(false),
    /** `null` = until closed (still capped at the 168 h class TTL). */
    expiresInMinutes: z
      .number()
      .int()
      .min(1)
      .max(ENDPOINT_MESSAGE_LIMITS.maxExpiresInMinutes)
      .nullable()
      .default(ENDPOINT_MESSAGE_LIMITS.defaultExpiresInMinutes),
    /** Required, and must equal the resolved device count, above `confirmAbove`. */
    confirmedCount: z.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const issue of endpointMessageContentIssues(v.title, v.body)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue, path: [issue.startsWith('title') ? 'title' : 'body'] });
    }
  });

export type EndpointMessageSendInput = z.infer<typeof endpointMessageSendSchema>;
export type EndpointMessageTargets = z.infer<typeof endpointMessageTargetsSchema>;
