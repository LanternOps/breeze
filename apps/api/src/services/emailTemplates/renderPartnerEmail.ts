import {
  type EmailTemplateId,
  emailTemplateHasCta,
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
}

const CTA_TOKEN_RE = /\{\{\s*cta_button\s*\}\}/g;
// Not a {{merge}} token, so renderTemplate will not eat it. Survives sanitize-html as text.
const CTA_SENTINEL = '%%BREEZE_CTA_BUTTON%%';

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

function renderRichInner(source: string, escaped: Record<string, string>): string {
  const sanitized = sanitizeRichTextHtml(source);
  const slotted = sanitized.replace(CTA_TOKEN_RE, CTA_SENTINEL);
  const substituted = substitute(slotted, escaped);
  return sanitizeRichTextHtml(substituted);
}

/** Drop the CTA sentinel from quoted attribute values so applyCta cannot
 *  splice an anchor into href/src. Text-position sentinels are left for
 *  button replacement. */
function stripSentinelFromAttributes(html: string): string {
  return html
    .replace(/(\s[A-Za-z_:][\w:.-]*=)("[^"]*")/g, (_m, eq: string, quoted: string) =>
      eq + quoted.replaceAll(CTA_SENTINEL, ''))
    .replace(/(\s[A-Za-z_:][\w:.-]*=)('[^']*')/g, (_m, eq: string, quoted: string) =>
      eq + quoted.replaceAll(CTA_SENTINEL, ''));
}

function applyCta(
  inner: string,
  id: EmailTemplateId,
  ctaUrl: string | undefined,
  label: string,
): string {
  inner = stripSentinelFromAttributes(inner);
  const slotted = inner.includes(CTA_SENTINEL);
  const safeUrl = ctaUrl && isSafeHttpUrl(ctaUrl) ? ctaUrl : null;
  if (emailTemplateHasCta(id) && safeUrl) {
    const button = renderButton(label, safeUrl);
    if (slotted) return inner.replaceAll(CTA_SENTINEL, button);
    return `${inner}${button}`;
  }
  return inner.replaceAll(CTA_SENTINEL, '');
}

export function renderPartnerEmail(args: RenderPartnerEmailArgs): { subject: string; html: string } {
  const vars = catalogVars(args.id, args.vars);
  const escaped = htmlEscaped(vars);
  const customSubject = args.custom?.subject?.trim() ? args.custom.subject : null;
  const customHeading = args.custom?.heading?.trim() ? args.custom.heading : null;
  const customButtonLabel = args.custom?.buttonLabel?.trim() ? args.custom.buttonLabel : null;
  const customHtml = args.custom?.html?.trim() ? args.custom.html : null;

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

  let inner: string;
  if (customHtml) {
    inner = renderRichInner(customHtml, escaped);
  } else if (inboundBody) {
    inner = `<p>${substitute(escapeHtml(inboundBody), escaped).replace(/\r?\n/g, '<br>')}</p>`;
  } else {
    inner = renderRichInner(defaultHtml(args.id, vars), escaped);
  }

  inner = applyCta(inner, args.id, args.ctaUrl, buttonLabel);

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
