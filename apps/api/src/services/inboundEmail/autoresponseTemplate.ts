import { escapeHtml } from '../emailLayout';
import { renderTemplate } from '@breeze/shared';

/** Acknowledgement email for an email-created ticket (spec §5). When a partner
 *  has customized the template, render it; otherwise emit the original hardcoded
 *  default byte-for-byte so existing partners see no change.
 *  Body is treated as PLAIN TEXT: the literal body and every variable value are
 *  HTML-escaped before substitution (customer-facing), then newlines → <br>. */
export function buildAutoresponseEmail(args: {
  internalNumber: string | null;
  subject: string;
  custom?: { subject: string | null; body: string | null };
  vars?: Record<string, string>;
}): { subject: string; html: string } {
  const label = args.internalNumber ?? 'your request';
  const tokenPrefix = args.internalNumber ? `[${args.internalNumber}] ` : '';
  const defaultSubject = `${tokenPrefix}We received your request: ${args.subject}`;

  const vars = args.vars ?? {};
  const customSubject = args.custom?.subject?.trim() ? args.custom.subject : null;
  const customBody = args.custom?.body?.trim() ? args.custom.body : null;

  const subject = customSubject
    ? renderTemplate(customSubject, vars).replace(/[\r\n]+/g, ' ').trim()
    : defaultSubject;

  let html: string;
  if (customBody) {
    const escapedVars = Object.fromEntries(
      Object.entries(vars).map(([k, v]) => [k, escapeHtml(v)]),
    );
    const rendered = renderTemplate(escapeHtml(customBody), escapedVars).replace(/\r?\n/g, '<br>');
    html = `<p>${rendered}</p>`;
  } else {
    html =
      `<p>Thanks — we've received your request and opened ticket <strong>${escapeHtml(label)}</strong>.</p>` +
      `<p>Reply to this email to add more detail; our team will follow up.</p>`;
  }

  return { subject, html };
}
