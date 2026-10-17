import { describe, expect, it, vi, beforeEach } from 'vitest';

const sendEmail = vi.hoisted(() => vi.fn());
const getEmailService = vi.hoisted(() => vi.fn());
vi.mock('../../email', () => ({ getEmailService }));

import {
  buildAccessDeniedEmail, buildAccessGrantedEmail, buildAccessVerificationEmail, buildStaffAccessRequestEmail,
  sendAccessGrantedEmail, sendAccessVerificationEmail, sendStaffAccessRequestEmail,
} from './emails';

const URL_V = 'https://portal.example.test/portal/trust/access/verify#' + 'x'.repeat(48);

beforeEach(() => {
  sendEmail.mockReset().mockResolvedValue(undefined);
  getEmailService.mockReset().mockReturnValue({ sendEmail });
});

describe('templates', () => {
  it('verification mail carries the fragment link and the 24-hour expiry', () => {
    const m = buildAccessVerificationEmail({ orgName: 'Contoso', partnerName: 'Acme MSP', verifyUrl: URL_V });
    expect(m.text).toContain(URL_V);
    expect(m.html).toContain('verify#');
    expect(m.text).toContain('24 hours');
  });
  it('escapes requester-controlled text in the staff notice', () => {
    const m = buildStaffAccessRequestEmail({
      orgName: 'Contoso', requesterName: '<script>x</script>', requesterEmail: 'a@b.test', requesterCompany: 'Evil & Co',
      purpose: '<img src=x onerror=alert(1)>', reviewUrl: 'https://app.example.test/organizations/o#trust',
    });
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('Evil &amp; Co');
  });
  it('granted mail lists the escaped titles and the UTC expiry date', () => {
    const m = buildAccessGrantedEmail({ orgName: 'Contoso', partnerName: 'Acme', downloadUrl: 'https://p/x#t', expiresAt: new Date('2026-10-24T12:00:00Z'), documentTitles: ['SOC <2>'] });
    expect(m.html).toContain('SOC &lt;2&gt;');
    expect(m.text).toContain('2026-10-24');
  });
  it('denied mail includes the note only when given', () => {
    expect(buildAccessDeniedEmail({ orgName: 'C', partnerName: 'A', note: null }).text).not.toContain('Note');
    expect(buildAccessDeniedEmail({ orgName: 'C', partnerName: 'A', note: 'Need an NDA' }).text).toContain('Need an NDA');
  });
});

describe('senders', () => {
  it('requester mail rides the partner lane with the partner named', async () => {
    await expect(sendAccessVerificationEmail({ to: 'r@x.test', partnerId: 'p1', partnerName: 'Acme' }, { orgName: 'C', partnerName: 'Acme', verifyUrl: URL_V })).resolves.toBe(true);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'r@x.test', purpose: 'trust.access_verification', partnerId: 'p1', partnerName: 'Acme' }));
  });
  it('staff mail is platform lane (no partnerId) and skips an empty recipient list', async () => {
    await expect(sendStaffAccessRequestEmail([], { orgName: 'C', requesterName: 'R', requesterEmail: 'r@x', requesterCompany: 'X', purpose: 'p', reviewUrl: 'u' })).resolves.toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    await sendStaffAccessRequestEmail(['s@msp.test'], { orgName: 'C', requesterName: 'R', requesterEmail: 'r@x', requesterCompany: 'X', purpose: 'p', reviewUrl: 'u' });
    const params = sendEmail.mock.calls[0]![0];
    expect(params.purpose).toBe('staff.trust_access_request');
    expect(params).not.toHaveProperty('partnerId');
  });
  it('a send failure is reported as false, never thrown', async () => {
    sendEmail.mockRejectedValueOnce(new Error('smtp down'));
    await expect(sendAccessGrantedEmail({ to: 'r@x', partnerId: 'p', partnerName: 'A' }, { orgName: 'C', partnerName: 'A', downloadUrl: 'u', expiresAt: new Date(), documentTitles: [] })).resolves.toBe(false);
  });
  it('no email service configured → false', async () => {
    getEmailService.mockReturnValue(null);
    await expect(sendAccessVerificationEmail({ to: 'r@x', partnerId: 'p', partnerName: 'A' }, { orgName: 'C', partnerName: 'A', verifyUrl: URL_V })).resolves.toBe(false);
  });
});
