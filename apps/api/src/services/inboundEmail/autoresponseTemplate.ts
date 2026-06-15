import { escapeHtml } from '../emailLayout';

/** Hardcoded v1 acknowledgement (spec §5). PR4 swaps this for a partner-branded
 *  template; keep the signature stable so the notify-worker branch is unchanged.
 *  Subject tokenization comes solely from here: with an internalNumber the subject
 *  carries the [T-...] token; without one it degrades to a token-less subject. */
export function buildAutoresponseEmail(args: { internalNumber: string | null; subject: string }): { subject: string; html: string } {
  const label = args.internalNumber ?? 'your request';
  const tokenPrefix = args.internalNumber ? `[${args.internalNumber}] ` : '';
  return {
    subject: `${tokenPrefix}We received your request: ${args.subject}`,
    html:
      `<p>Thanks — we've received your request and opened ticket <strong>${escapeHtml(label)}</strong>.</p>` +
      `<p>Reply to this email to add more detail; our team will follow up.</p>`,
  };
}
