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

/**
 * First agent release with the `retract_message` handler (#8742 W02). A
 * W1-era agent has the IPC type but no command handler, so retract is refused
 * (`agent_unsupported`) below it. Same fail-closed placeholder as above until
 * the release is cut.
 */
export const ENDPOINT_MESSAGE_RETRACT_MIN_AGENT_VERSION = '999.0.0';

function versionAtLeast(agentVersion: string | null | undefined, min: string): boolean {
  if (typeof agentVersion !== 'string' || agentVersion.trim() === '') return false;
  const cmp = semverCompare(agentVersion.trim(), min);
  return cmp !== null && cmp >= 0;
}

/** False for null, unparseable and older versions — never guesses in favour. */
export function agentSupportsEndpointMessaging(agentVersion: string | null | undefined): boolean {
  return versionAtLeast(agentVersion, ENDPOINT_MESSAGING_MIN_AGENT_VERSION);
}

/** Same fail-closed rule for the retract handler. */
export function agentSupportsEndpointMessageRetract(agentVersion: string | null | undefined): boolean {
  return versionAtLeast(agentVersion, ENDPOINT_MESSAGE_RETRACT_MIN_AGENT_VERSION);
}

/** Resend body: a fresh client id; the content comes from the stored message. */
export const endpointMessageResendSchema = z.object({ messageId: z.string().uuid() }).strict();
export type EndpointMessageResendInput = z.infer<typeof endpointMessageResendSchema>;

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

// Reference-style markdown is not part of the allowed subset: a definition
// line hides its target away from the visible link text, and `[a][b]` /
// `![a][b]` / `[a][]` resolve through one.
const REFERENCE_DEFINITION = /^[ \t]*\[[^\]]+\]:[ \t]*\S+/m;
const REFERENCE_LINK = /!?\[[^\]]+\][ \t]?\[[^\]]*\]/;
// Bare non-https scheme tokens a renderer or the OS may act on (mailto:, tel:,
// ms-settings: ...). A closed list plus the `ms-` / `x-` families, not "any
// word followed by a colon", so "Note: call us", "10:30" and "Status:ok" stay fine.
const BARE_OTHER_SCHEME =
  /\b(?:mailto|tel|sms|smsto|callto|facetime|skype|sip|sips|xmpp|geo|intent|market|slack|zoommtg|zoomus|msteams|teams|ssh|telnet|smb|ldap|ldaps|vnc|rdp|steam|news|nntp|irc|about|blob|view-source|(?:ms|x)-[a-z0-9-]+):/i;
const HTTPS_URL_RUN = /https:\/\/[^\s)>\]]+/gi;

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
  // Scan for other schemes with the (allowed) https URLs removed, so a
  // `?next=tel:5` inside a legitimate https link is not a false positive.
  if (BARE_OTHER_SCHEME.test(body.replace(HTTPS_URL_RUN, ' '))) issues.push('links must use https');
  if (REFERENCE_DEFINITION.test(body) || REFERENCE_LINK.test(body)) issues.push('reference links are not allowed');
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
