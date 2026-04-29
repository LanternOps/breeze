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

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif';

export interface RenderLayoutOptions {
  title: string;
  preheader: string;
  heading?: string;
  body: string;
  footer?: string;
}

export function renderLayout(options: RenderLayoutOptions): string {
  const { title, preheader, heading, body, footer } = options;
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
          <p style="margin: 16px 0 0; font-size: 12px; color: ${FAINT_COLOR}; font-family: ${FONT_STACK};">Breeze RMM</p>
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
