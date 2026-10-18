import { describe, expect, it } from 'vitest';
import { buildDeclarationReminderEmail } from './declarationReminderEmail';

const base = {
  controlTitle: 'Incident response plan', orgName: 'Acme Dental', partnerName: 'Northwind IT',
  expiresAt: new Date('2027-10-17T12:00:00.000Z'), link: 'https://app.example.com/organizations/o1#trust',
};

describe('buildDeclarationReminderEmail', () => {
  it('names the control, the org and the UTC expiry date, and links to the trust tab', () => {
    const out = buildDeclarationReminderEmail(base);
    expect(out.subject).toBe('Declared control "Incident response plan" expires on October 17, 2027');
    expect(out.text).toContain('Incident response plan on Acme Dental’s trust page expires on October 17, 2027');
    expect(out.text).toContain('Re-declare it and publish the page again');
    expect(out.text).toContain(base.link);
    expect(out.html).toContain('href="https://app.example.com/organizations/o1#trust"');
  });

  it('escapes publisher-controlled names in the HTML body', () => {
    const out = buildDeclarationReminderEmail({ ...base, orgName: '<script>x</script> & Co' });
    expect(out.html).not.toContain('<script>x</script>');
    expect(out.html).toContain('&lt;script&gt;x&lt;/script&gt; &amp; Co');
  });

  it('without an absolute link it omits the button rather than sending a relative URL', () => {
    const out = buildDeclarationReminderEmail({ ...base, link: null });
    expect(out.html).not.toContain('href=');
    expect(out.text).not.toContain('http');
  });
});
