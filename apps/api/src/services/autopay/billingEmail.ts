import { formatCalendarDate, formatMoney, type EmailTemplateId } from '@breeze/shared';
import { escapeHtml, renderLinkRow, renderSummaryTable, renderTermsBlock } from '../emailLayout';
import { renderPartnerEmail, type PartnerEmailCustom } from '../emailTemplates/renderPartnerEmail';

/**
 * One composer for every client billing email: the partner-editable body (with its
 * button), then the locked blocks the partner cannot remove, in a fixed order:
 * locked paragraphs, the facts table, secondary links, open invoices, notes, terms.
 * The text part is built from the same parts, so each fact appears once (lab D-9)
 * and nothing hidden (preheader) leaks into it.
 */
export interface BillingEmailLink { label: string; url: string; note?: string }
export interface BillingEmailInput {
  id: EmailTemplateId;
  variant?: string;
  custom?: PartnerEmailCustom | null;
  vars: Record<string, string>;
  /** The MSP's name, printed under the card. */
  brandName: string;
  ctaUrl?: string;
  ctaLabel?: string;
  preheader?: string;
  footer?: string;
  lockedParagraphs?: string[];
  summary?: { label: string; value: string }[];
  links?: BillingEmailLink[];
  openInvoices?: { number: string; amount: string; url: string }[];
  notes?: string[];
  terms?: { title: string; paragraphs: string[] };
}

function checkedUrl(value: string): string {
  const parsed = new URL(value);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Unsafe billing URL');
  return value;
}
const paragraph = (inner: string, muted = false) =>
  `<p style="margin: 0 0 12px; font-size: ${muted ? '13px' : '15px'}; line-height: 1.55; color: ${muted ? '#6b7280' : '#1f2937'};">${inner}</p>`;

export function renderBillingEmail(input: BillingEmailInput): { subject: string; html: string; text: string } {
  const links = (input.links ?? []).map(link => ({ ...link, url: checkedUrl(link.url) }));
  const invoices = input.openInvoices?.map(invoice => ({ ...invoice, url: checkedUrl(invoice.url) }));
  const html: string[] = [];
  const text: string[] = [];
  for (const line of input.lockedParagraphs ?? []) { html.push(paragraph(escapeHtml(line))); text.push(line); }
  if (input.summary?.length) {
    html.push(renderSummaryTable(input.summary));
    text.push(input.summary.map(row => `${row.label}: ${row.value}`).join('\n'));
  }
  const plain = links.filter(link => !link.note);
  if (plain.length) { html.push(renderLinkRow(plain)); text.push(plain.map(link => `${link.label}: ${link.url}`).join('\n')); }
  for (const link of links.filter(link => link.note)) {
    html.push(paragraph(`${escapeHtml(link.note!)} <a href="${escapeHtml(link.url)}" style="color: #155e75; text-decoration: underline;">${escapeHtml(link.label)}</a>`));
    text.push(`${link.note} ${link.label}: ${link.url}`);
  }
  if (invoices) {
    if (invoices.length) {
      html.push(paragraph('<strong>Invoices still open</strong>'));
      html.push(...invoices.map(invoice => paragraph(`${escapeHtml(invoice.number)} · ${escapeHtml(invoice.amount)} · `
        + `<a href="${escapeHtml(invoice.url)}" style="color: #155e75; text-decoration: underline;">View and pay</a>`)));
      text.push(['Invoices still open', ...invoices.map(invoice => `${invoice.number} · ${invoice.amount}: ${invoice.url}`)].join('\n'));
    } else {
      html.push(paragraph('You have no open invoices right now.'));
      text.push('You have no open invoices right now.');
    }
  }
  for (const note of input.notes ?? []) { html.push(paragraph(escapeHtml(note), true)); text.push(note); }
  if (input.terms) {
    html.push(renderTermsBlock(input.terms.title, input.terms.paragraphs));
    text.push([input.terms.title, ...input.terms.paragraphs].join('\n'));
  }
  const rendered = renderPartnerEmail({ id: input.id, variant: input.variant, custom: input.custom ?? null, vars: input.vars,
    ctaUrl: input.ctaUrl, ctaLabel: input.ctaLabel, brandName: input.brandName, preheader: input.preheader, footer: input.footer,
    bodyAfterCta: html.join('') || undefined });
  const footer = input.footer;
  return { subject: rendered.subject, html: rendered.html,
    text: [rendered.heading, rendered.bodyText, ...text, footer, input.brandName].filter(part => !!part && part.trim()).join('\n\n') };
}

/** Money in every client billing email: "$100.00", "CA$1,234.50". */
export function emailMoney(amount: string | number, currency: string): string {
  return formatMoney(amount, currency, 'en-US');
}
/** Dates in every client billing email: "November 4, 2026" (UTC calendar day). */
export function emailDate(value: string | Date | null | undefined): string {
  return formatCalendarDate(value instanceof Date ? value.toISOString() : value, 'en-US', 'UTC');
}
/** "Hi …,": the billing contact's name, else the organization. Never an email address (D-9). */
export function clientNameFor(billingContact: unknown, orgName: string | null | undefined): string {
  const name = billingContact && typeof billingContact === 'object' ? (billingContact as { name?: unknown }).name : null;
  if (typeof name === 'string' && name.trim() && !name.includes('@')) return name.trim();
  return orgName?.trim() || 'there';
}
