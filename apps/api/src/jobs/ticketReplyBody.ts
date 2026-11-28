import { escapeHtml } from '../services/emailLayout';

/**
 * The technician's public reply as email HTML (email-first replies W1, Refs
 * #8758): escaped, newlines kept, in a quoted block. Rendered before the
 * button of the `with_reply` Public reply notice (renderPartnerEmail
 * `bodyBeforeCta`). The comment `content` is plain text authored by a
 * technician, so nothing in it is ever treated as markup.
 */
export function replyBodyHtml(content: string): string {
  const safe = escapeHtml(content).replace(/\r?\n/g, '<br>');
  return '<div style="margin-top:16px;padding:12px 16px;border-left:3px solid #d1d5db;'
    + 'color:#374151;font-size:14px;line-height:1.5;white-space:normal;">'
    + `${safe}</div>`;
}
