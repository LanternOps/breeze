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
  brandName?: string;
  footer?: string;
  preheader?: string;
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
  ctaLabel?: string;
  bodyBeforeCta?: string;
  bodyAfterCta?: string;
}

const CTA_TOKEN_RE = /\{\{\s*cta_button\s*\}\}/g;

function makeCtaSentinel(): string {
  return `%%BREEZE_CTA_${crypto.randomUUID()}%%`;
}

/** Closed catalog only — leftover keys like comment / agent_name must not substitute. */
function catalogVars(id: EmailTemplateId, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of varsForEmailTemplate(id)) {
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
    subject = defaultSubject(args.id, { internalNumber: args.internalNumber, ticketSubject });
  }

  const heading = customHeading ? substitute(customHeading, vars) : defaultHeading(args.id);
  const buttonLabel = customButtonLabel
    ? substitute(customButtonLabel, vars)
    : defaultButtonLabel(args.id);

  const sentinel = makeCtaSentinel();
  let inner: string;
  if (customHtml) {
    inner = renderRichInner(customHtml, escaped, sentinel);
  } else if (inboundBody) {
    inner = `<p>${substitute(escapeHtml(inboundBody), escaped).replace(/\r?\n/g, '<br>')}</p>`;
  } else {
    inner = renderRichInner(defaultHtml(args.id, vars), escaped, sentinel);
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
