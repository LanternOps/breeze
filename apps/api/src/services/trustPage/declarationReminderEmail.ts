// Owner: W02b. The 30-day "a declared control expires soon" email to MSP staff (spec §18.2). Platform lane
// (purpose 'staff.trust_declaration_reminder'): it goes to the MSP's own users, never to the customer.
import { escapeHtml, renderButton, renderLayout, renderParagraph } from '../emailLayout';

export interface DeclarationReminderEmailParams {
  controlTitle: string;
  orgName: string;
  partnerName: string;
  expiresAt: Date;
  /** Absolute link to the org's Trust Center tab, or null when no app URL is configured. */
  link: string | null;
}

export function formatReminderDate(d: Date): string {
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export function buildDeclarationReminderEmail(p: DeclarationReminderEmailParams): { subject: string; html: string; text: string } {
  const date = formatReminderDate(p.expiresAt);
  const subject = `Declared control "${p.controlTitle}" expires on ${date}`;
  const lead = `${p.controlTitle} on ${p.orgName}’s trust page expires on ${date}.`;
  const action = 'Re-declare it and publish the page again, or the public page will show it as expired.';
  const note = `Declarations are made on behalf of ${p.partnerName} and last 365 days.`;
  const html = renderLayout({
    title: 'A declared control expires soon',
    preheader: lead,
    heading: 'A declared control expires soon',
    body: [
      renderParagraph(escapeHtml(lead)),
      renderParagraph(escapeHtml(action)),
      p.link ? renderButton('Open the Trust Center', p.link) : '',
      renderParagraph(escapeHtml(note), { muted: true, marginTop: 16 }),
    ].join(''),
  });
  const text = [lead, action, p.link ? `Open the Trust Center: ${p.link}` : null, note].filter(Boolean).join('\n\n');
  return { subject, html, text };
}
