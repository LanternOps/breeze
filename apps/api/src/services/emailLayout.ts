/**
 * Shared layout primitives for transactional emails.
 *
 * Every Breeze transactional email goes through `renderLayout` so the brand,
 * type, color, and structural defaults stay consistent. New templates should
 * never inline their own HTML shell.
 */

const ACCENT_COLOR = '#155e75';
const ACCENT_TEXT = '#ffffff';
const HEADING_COLOR = '#0f172a';
const BODY_COLOR = '#1f2937';
const MUTED_COLOR = '#6b7280';
const FAINT_COLOR = '#94a3b8';
const PAGE_BG = '#eef2f7';
const CARD_BG = '#ffffff';

// Single quotes only: this value is interpolated into double-quoted style=""
// attributes, where a double quote would end the attribute and drop every
// later declaration (the body then rendered in the client's default serif).
const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Helvetica, Arial, sans-serif";

export interface RenderLayoutOptions {
  title: string;
  preheader: string;
  heading?: string;
  body: string;
  footer?: string;
  /** Faint brand line under the card. Defaults to the platform brand; partner-
   * facing emails (quotes/invoices) pass the MSP's name so the customer sees
   * their provider, not Breeze. */
  brandName?: string;
}

export function renderLayout(options: RenderLayoutOptions): string {
  const { title, preheader, heading, body, footer, brandName } = options;
  const headingBlock = heading
    ? `<tr>
              <td style="padding: 28px 32px 4px; font-family: ${FONT_STACK};">
                <h1 style="margin: 0; font-size: 20px; line-height: 1.3; color: ${HEADING_COLOR}; font-weight: 600; font-family: ${FONT_STACK};">${escapeHtml(heading)}</h1>
              </td>
            </tr>`
    : '';
  const bodyTopPad = heading ? '8px' : '28px';
  const footerBlock = footer
    ? `<tr>
              <td style="padding: 0 32px 24px; font-family: ${FONT_STACK};">
                <p style="margin: 0; font-size: 12px; line-height: 1.5; color: ${MUTED_COLOR};">${escapeHtml(footer)}</p>
              </td>
            </tr>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${escapeHtml(title)}</title>
    <style>p { margin: 0 0 12px; } a { color: ${ACCENT_COLOR}; }</style>
  </head>
  <body style="margin: 0; padding: 0; background: ${PAGE_BG}; font-family: ${FONT_STACK}; color: ${BODY_COLOR};">
    <div style="display: none; max-height: 0; overflow: hidden; mso-hide: all; font-size: 1px; line-height: 1px; color: ${PAGE_BG};">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: ${PAGE_BG}; padding: 24px 0; font-family: ${FONT_STACK};">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background: ${CARD_BG}; border-radius: 12px; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.06); overflow: hidden;">
            <tr>
              <td style="height: 3px; background: ${ACCENT_COLOR}; line-height: 3px; font-size: 0;">&nbsp;</td>
            </tr>
            ${headingBlock}
            <tr>
              <td style="padding: ${bodyTopPad} 32px 24px; font-family: ${FONT_STACK}; color: ${BODY_COLOR}; font-size: 15px; line-height: 1.55;">
                ${body}
              </td>
            </tr>
            ${footerBlock}
          </table>
          <p style="margin: 16px 0 0; font-size: 12px; color: ${FAINT_COLOR}; font-family: ${FONT_STACK};">${escapeHtml(brandName ?? 'Breeze RMM')}</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function renderButton(label: string, url: string): string {
  return `<a href="${escapeHtml(url)}" style="display: inline-block; padding: 12px 22px; border-radius: 8px; background: ${ACCENT_COLOR}; color: ${ACCENT_TEXT}; font-size: 14px; font-weight: 500; text-decoration: none; font-family: ${FONT_STACK};">${escapeHtml(label)}</a>`;
}

export function renderParagraph(content: string, options: { muted?: boolean; marginTop?: number } = {}): string {
  const color = options.muted ? MUTED_COLOR : BODY_COLOR;
  const size = options.muted ? '13px' : '15px';
  const marginTop = options.marginTop ?? 0;
  return `<p style="margin: ${marginTop}px 0 12px; font-size: ${size}; line-height: 1.55; color: ${color}; font-family: ${FONT_STACK};">${content}</p>`;
}

const RULE = '#e5e7eb';

/** Locked facts of a billing email ("Amount", "Payment date", "Paid with"): a
 * presentational two-column table that stays legible at 390px. */
export function renderSummaryTable(rows: { label: string; value: string }[]): string {
  if (!rows.length) return '';
  const cells = rows.map((row, index) => {
    const border = `border-top: 1px solid ${RULE};${index === rows.length - 1 ? ` border-bottom: 1px solid ${RULE};` : ''}`;
    return `<tr><td style="${border} width: 40%; padding: 10px 12px 10px 0; vertical-align: top; font-size: 13px; line-height: 1.45; color: ${MUTED_COLOR}; font-family: ${FONT_STACK};">${escapeHtml(row.label)}</td>`
      + `<td style="${border} padding: 10px 0; vertical-align: top; font-size: 15px; line-height: 1.45; font-weight: 600; color: ${HEADING_COLOR}; font-family: ${FONT_STACK};">${escapeHtml(row.value)}</td></tr>`;
  }).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 16px 0 20px; border-collapse: collapse; width: 100%;">${cells}</table>`;
}

/** Secondary actions ("Skip this payment · Stop automatic payments") as real links. */
export function renderLinkRow(links: { label: string; url: string }[]): string {
  if (!links.length) return '';
  const anchors = links.map(link => `<a href="${escapeHtml(link.url)}" style="color: ${ACCENT_COLOR}; text-decoration: underline;">${escapeHtml(link.label)}</a>`);
  return `<p style="margin: 16px 0 12px; font-size: 14px; line-height: 1.6; font-family: ${FONT_STACK};">${anchors.join('&nbsp;·&nbsp;')}</p>`;
}

/** A muted, boxed block for terms and legal lines (the authorization copy, notes). */
export function renderTermsBlock(title: string, paragraphs: string[]): string {
  const body = paragraphs.map(text => `<p style="margin: 0 0 8px; font-size: 13px; line-height: 1.55; color: #374151; font-family: ${FONT_STACK};">${escapeHtml(text)}</p>`).join('');
  return `<div style="margin: 24px 0 0; padding: 16px; background: #f8fafc; border: 1px solid ${RULE}; border-radius: 8px;">`
    + `<p style="margin: 0 0 6px; font-size: 13px; font-weight: 600; color: ${HEADING_COLOR}; font-family: ${FONT_STACK};">${escapeHtml(title)}</p>${body}</div>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function getSupportEmail(explicit?: string): string | undefined {
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const fromEnv = process.env.EMAIL_SUPPORT_ADDRESS;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  return undefined;
}
