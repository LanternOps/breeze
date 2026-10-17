// Owner: W02d. The four emails of the gated-document flow. Requester-facing mail rides the partner lane (the
// MSP's sending domain, or its company name as the display name); the staff notice is platform lane.
// Every interpolated value is escaped: the requester's name, company and purpose are attacker-controlled.
import { escapeHtml, renderButton, renderLayout, renderParagraph } from '../../emailLayout';
import { getEmailService } from '../../email';

export interface TrustAccessEmail { subject: string; html: string; text: string }

function dateLabel(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function buildAccessVerificationEmail(p: { orgName: string; partnerName: string; verifyUrl: string }): TrustAccessEmail {
  const lead = `Someone asked for access to ${p.orgName}'s security documents using this address. `
    + 'Confirm the request to send it for review. If this was not you, ignore this email and nothing happens.';
  return {
    subject: `Confirm your request for ${p.orgName}'s security documents`,
    html: renderLayout({
      title: 'Confirm your document request', preheader: `Confirm your request for ${p.orgName}'s security documents.`,
      heading: 'Confirm your document request', brandName: p.partnerName,
      body: `${renderParagraph(escapeHtml(lead))}${renderButton('Confirm request', p.verifyUrl)}`
        + renderParagraph('This link expires in 24 hours.', { muted: true, marginTop: 16 }),
    }),
    text: `${lead}\n\nConfirm request: ${p.verifyUrl}\n\nThis link expires in 24 hours.`,
  };
}

export function buildAccessGrantedEmail(p: {
  orgName: string; partnerName: string; downloadUrl: string; expiresAt: Date; documentTitles: string[];
}): TrustAccessEmail {
  const lead = `${p.partnerName} approved your request for ${p.orgName}'s security documents.`;
  const until = `The link works until ${dateLabel(p.expiresAt)} (UTC). Do not forward it: anyone with the link can download the documents.`;
  const list = p.documentTitles.length
    ? `<ul>${p.documentTitles.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>` : '';
  return {
    subject: `Your access to ${p.orgName}'s security documents`,
    html: renderLayout({
      title: 'Your documents are ready', preheader: lead, heading: 'Your documents are ready', brandName: p.partnerName,
      body: `${renderParagraph(escapeHtml(lead))}${list}${renderButton('Open documents', p.downloadUrl)}`
        + renderParagraph(escapeHtml(until), { muted: true, marginTop: 16 }),
    }),
    text: `${lead}\n\n${p.documentTitles.map((t) => `- ${t}`).join('\n')}\n\nOpen documents: ${p.downloadUrl}\n\n${until}`,
  };
}

export function buildAccessDeniedEmail(p: { orgName: string; partnerName: string; note: string | null }): TrustAccessEmail {
  const lead = `${p.partnerName} declined your request for ${p.orgName}'s security documents.`;
  const note = p.note ? `Note from ${p.partnerName}: ${p.note}` : null;
  return {
    subject: `Your request for ${p.orgName}'s security documents`,
    html: renderLayout({
      title: 'Document request declined', preheader: lead, heading: 'Document request declined', brandName: p.partnerName,
      body: renderParagraph(escapeHtml(lead)) + (note ? renderParagraph(escapeHtml(note), { marginTop: 12 }) : ''),
    }),
    text: note ? `${lead}\n\n${note}` : lead,
  };
}

export function buildStaffAccessRequestEmail(p: {
  orgName: string; requesterName: string; requesterEmail: string; requesterCompany: string; purpose: string; reviewUrl: string;
}): TrustAccessEmail {
  const lead = `${p.requesterName} (${p.requesterCompany}, ${p.requesterEmail}) confirmed a request for ${p.orgName}'s gated trust page documents.`;
  return {
    subject: `Trust Center: document request for ${p.orgName}`,
    html: renderLayout({
      title: 'Document access request', preheader: lead, heading: 'Document access request',
      body: renderParagraph(escapeHtml(lead)) + renderParagraph(`Purpose: ${escapeHtml(p.purpose)}`, { marginTop: 12 })
        + renderButton('Review the request', p.reviewUrl),
    }),
    text: `${lead}\n\nPurpose: ${p.purpose}\n\nReview the request: ${p.reviewUrl}`,
  };
}

// ---- senders. Each is best-effort for its caller: a false return is logged, never thrown into a committed flow
// (Open Decision 3: at-most-once; the MSP can Resend a grant).

type PartnerLane = { to: string; partnerId: string; partnerName: string };

async function sendPartnerLane(
  purpose: 'trust.access_verification' | 'trust.access_granted' | 'trust.access_denied',
  a: PartnerLane, mail: TrustAccessEmail,
): Promise<boolean> {
  const service = getEmailService();
  if (!service) { console.warn(`[trustAccess] email not configured; ${purpose} not sent`); return false; }
  try {
    await service.sendEmail({ to: a.to, subject: mail.subject, html: mail.html, text: mail.text, purpose, partnerId: a.partnerId, partnerName: a.partnerName });
    return true;
  } catch (err) {
    console.error(`[trustAccess] ${purpose} send failed`, err instanceof Error ? err.message : err);
    return false;
  }
}

export function sendAccessVerificationEmail(a: PartnerLane, p: Parameters<typeof buildAccessVerificationEmail>[0]): Promise<boolean> {
  return sendPartnerLane('trust.access_verification', a, buildAccessVerificationEmail(p));
}
export function sendAccessGrantedEmail(a: PartnerLane, p: Parameters<typeof buildAccessGrantedEmail>[0]): Promise<boolean> {
  return sendPartnerLane('trust.access_granted', a, buildAccessGrantedEmail(p));
}
export function sendAccessDeniedEmail(a: PartnerLane, p: Parameters<typeof buildAccessDeniedEmail>[0]): Promise<boolean> {
  return sendPartnerLane('trust.access_denied', a, buildAccessDeniedEmail(p));
}

export async function sendStaffAccessRequestEmail(to: string[], p: Parameters<typeof buildStaffAccessRequestEmail>[0]): Promise<boolean> {
  if (to.length === 0) return false;
  const service = getEmailService();
  if (!service) { console.warn('[trustAccess] email not configured; staff.trust_access_request not sent'); return false; }
  const mail = buildStaffAccessRequestEmail(p);
  try {
    await service.sendEmail({ to, subject: mail.subject, html: mail.html, text: mail.text, purpose: 'staff.trust_access_request' });
    return true;
  } catch (err) {
    console.error('[trustAccess] staff.trust_access_request send failed', err instanceof Error ? err.message : err);
    return false;
  }
}
