import {
  type EmailTemplateId,
  emailTemplateHasCta,
  isBlankEmailTemplateHtml,
  renderTemplate,
  type TicketTemplateVars,
  varsForEmailTemplate,
} from '@breeze/shared';
import { escapeHtml, renderButton, renderLayout } from '../emailLayout';
import { sanitizeRichTextHtml } from '../richTextSanitize';
import {
  defaultButtonLabel,
  defaultFooter,
  defaultHeading,
  defaultHtml,
  defaultPreheader,
  defaultSubject,
} from './defaults';

export interface PartnerEmailCustom {
  subject: string | null;
  heading: string | null;
  buttonLabel: string | null;
  html: string | null;
}

export interface RenderPartnerEmailArgs {
  id: EmailTemplateId;
  custom?: PartnerEmailCustom | null;
  vars: Record<string, string>;
  ctaUrl?: string;
  /** Overrides the catalog default button label when custom.buttonLabel is empty. */
  ctaLabel?: string;
  brandName?: string;
  footer?: string;
  preheader?: string;
  /** Already-escaped HTML inserted after the partner body and before the CTA. */
  bodyBeforeCta?: string;
  /** Already-escaped HTML inserted after the CTA. */
  bodyAfterCta?: string;
  /** Ticket number / subject used only to build default subject lines. */
  internalNumber?: string | null;
  ticketSubject?: string;
  /**
   * When `id === 'ticket_autoresponse'` and `custom` is null/empty,
   * fall back to inbound plain-text autoresponseSubject/Body (escaped <p> + <br>),
   * then the hardcoded ack. Do not wrap that fallback path's INNER html in
   * extra sanitizer loss; DO still wrap the final document in renderLayout.
   */
  inboundAutoresponseFallback?: { subject: string | null; body: string | null };
}

export function parsePartnerEmailCustom(raw: unknown): PartnerEmailCustom | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return {
    subject: typeof o.subject === 'string' ? o.subject : null,
    heading: typeof o.heading === 'string' ? o.heading : null,
    buttonLabel: typeof o.buttonLabel === 'string' ? o.buttonLabel : null,
    html: typeof o.html === 'string' ? o.html : null,
  };
}

export function partnerEmailCustomFromSettings(
  settings: unknown,
  id: EmailTemplateId,
): PartnerEmailCustom | null {
  if (settings == null || typeof settings !== 'object') return null;
  const bag = (settings as { emailTemplates?: unknown }).emailTemplates;
  if (bag == null || typeof bag !== 'object') return null;
  return parsePartnerEmailCustom((bag as Record<string, unknown>)[id]);
}

const CTA_TOKEN_RE = /\{\{\s*cta_button\s*\}\}/g;

function makeCtaSentinel(): string {
  return `%%BREEZE_CTA_${crypto.randomUUID()}%%`;
}

/** Closed catalog only — leftover keys like comment / agent_name must not substitute. */
function catalogVars(id: EmailTemplateId, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of varsForEmailTemplate(id)) {
    if (key === 'cta_button') continue;
    out[key] = vars[key] ?? '';
  }
  return out;
}

function htmlEscaped(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    out[key] = escapeHtml(value);
  }
  return out;
}

function substitute(template: string, vars: Record<string, string>): string {
  return renderTemplate(template, vars as TicketTemplateVars);
}

function isSafeHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function renderRichInner(source: string, escaped: Record<string, string>, sentinel: string): string {
  const sanitized = sanitizeRichTextHtml(source);
  const slotted = sanitized.replace(CTA_TOKEN_RE, sentinel);
  const substituted = substitute(slotted, escaped);
  return sanitizeRichTextHtml(substituted);
}

/** Drop the CTA sentinel from quoted attribute values so splice/applyCta cannot
 *  splice HTML into href/src. Text-position sentinels are left for the button. */
function stripSentinelFromAttributes(html: string, sentinel: string): string {
  return html
    .replace(/(\s[A-Za-z_:][\w:.-]*=)("[^"]*")/g, (_m, eq: string, quoted: string) =>
      eq + quoted.replaceAll(sentinel, ''))
    .replace(/(\s[A-Za-z_:][\w:.-]*=)('[^']*')/g, (_m, eq: string, quoted: string) =>
      eq + quoted.replaceAll(sentinel, ''));
}

function applyCta(
  inner: string,
  id: EmailTemplateId,
  ctaUrl: string | undefined,
  label: string,
  sentinel: string,
): string {
  inner = stripSentinelFromAttributes(inner, sentinel);
  const slotted = inner.includes(sentinel);
  const safeUrl = ctaUrl && isSafeHttpUrl(ctaUrl) ? ctaUrl : null;
  if (emailTemplateHasCta(id) && safeUrl) {
    const button = renderButton(label, safeUrl);
    if (slotted) return inner.replaceAll(sentinel, button);
    return `${inner}${button}`;
  }
  return inner.replaceAll(sentinel, '');
}

function spliceBeforeCta(inner: string, beforeCta: string | undefined, sentinel: string): string {
  if (!beforeCta) return inner;
  if (inner.includes(sentinel)) {
    return inner.replace(sentinel, `${beforeCta}${sentinel}`);
  }
  return `${inner}${beforeCta}`;
}

export function renderPartnerEmail(args: RenderPartnerEmailArgs): { subject: string; html: string } {
  const vars = catalogVars(args.id, args.vars);
  const escaped = htmlEscaped(vars);
  const customSubject = args.custom?.subject?.trim() ? args.custom.subject : null;
  const customHeading = args.custom?.heading?.trim() ? args.custom.heading : null;
  const customButtonLabel = args.custom?.buttonLabel?.trim() ? args.custom.buttonLabel : null;
  const customHtml = args.custom?.html && !isBlankEmailTemplateHtml(args.custom.html)
    ? args.custom.html
    : null;

  const inbound = args.id === 'ticket_autoresponse' && !customSubject && !customHtml
    ? args.inboundAutoresponseFallback
    : undefined;
  const inboundSubject = inbound?.subject?.trim() ? inbound.subject : null;
  const inboundBody = inbound?.body?.trim() ? inbound.body : null;

  const ticketSubject = args.ticketSubject ?? vars.ticket_subject ?? '';
  let subject: string;
  if (customSubject) {
    subject = substitute(customSubject, vars).replace(/[\r\n]+/g, ' ').trim();
  } else if (inboundSubject) {
    subject = substitute(inboundSubject, vars).replace(/[\r\n]+/g, ' ').trim();
  } else {
    subject = defaultSubject(args.id, { internalNumber: args.internalNumber, ticketSubject, vars });
  }

  const heading = customHeading
    ? substitute(customHeading, vars)
    : substitute(defaultHeading(args.id, vars), vars);
  const buttonLabel = customButtonLabel
    ? substitute(customButtonLabel, vars)
    : (args.ctaLabel ?? defaultButtonLabel(args.id));

  const sentinel = makeCtaSentinel();
  let inner: string;
  if (customHtml) {
    inner = renderRichInner(customHtml, escaped, sentinel);
  } else if (inboundBody) {
    inner = `<p>${substitute(escapeHtml(inboundBody), escaped).replace(/\r?\n/g, '<br>')}</p>`;
  } else {
    inner = renderRichInner(defaultHtml(args.id, { ...args.vars, ...vars }), escaped, sentinel);
  }

  inner = stripSentinelFromAttributes(inner, sentinel);
  inner = spliceBeforeCta(inner, args.bodyBeforeCta, sentinel);
  inner = applyCta(inner, args.id, args.ctaUrl, buttonLabel, sentinel);
  if (args.bodyAfterCta) inner = `${inner}${args.bodyAfterCta}`;

  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: args.preheader ?? defaultPreheader(args.id),
      heading,
      body: inner,
      footer: args.footer ?? defaultFooter(args.id),
      brandName: args.brandName,
    }),
  };
}
