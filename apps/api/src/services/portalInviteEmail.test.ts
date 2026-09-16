import { describe, it, expect } from 'vitest';
import { buildPortalInviteTemplate } from './email';

describe('buildPortalInviteTemplate', () => {
  it('includes the invite URL and org name', () => {
    const t = buildPortalInviteTemplate({ to: 'c@a.example', inviteUrl: 'https://us.2breeze.app/portal/accept-invite?token=abc', orgName: 'Acme Co', inviterName: 'Tess', partnerId: null });
    expect(t.subject).toContain('Acme Co');
    expect(t.html).toContain('https://us.2breeze.app/portal/accept-invite?token=abc');
    expect(t.text).toContain('https://us.2breeze.app/portal/accept-invite?token=abc');
  });
  it('renders a generic subject without an org name', () => {
    const t = buildPortalInviteTemplate({ to: 'c@a.example', inviteUrl: 'https://x/portal/accept-invite?token=1', partnerId: null });
    expect(t.subject.length).toBeGreaterThan(0);
  });
  it('includes an optional custom message', () => {
    const t = buildPortalInviteTemplate({ to: 'c@a.example', inviteUrl: 'https://x/p?t=1', message: 'Welcome aboard!', partnerId: null });
    expect(t.html).toContain('Welcome aboard!');
  });

  it('null custom keeps current wording and the server invite URL', () => {
    const inviteUrl = 'https://us.2breeze.app/portal/accept-invite?token=abc';
    const t = buildPortalInviteTemplate({
      to: 'c@a.example',
      inviteUrl,
      orgName: 'Acme Co',
      inviterName: 'Tess',
      custom: null,
    });
    expect(t.html).toContain('Tess invited you');
    expect(t.html).toContain('Acme Co');
    expect(t.html).toContain('support portal, where you can open tickets');
    expect(t.html).toContain('expires in 7 days');
    expect(t.html).toContain(`href="${inviteUrl}"`);
    expect(t.text).toContain(inviteUrl);
  });

  it('custom html substitutes requester_name and keeps the server invite URL', () => {
    const inviteUrl = 'https://us.2breeze.app/portal/accept-invite?token=abc';
    const t = buildPortalInviteTemplate({
      to: 'c@a.example',
      inviteUrl,
      orgName: 'Acme Co',
      inviterName: 'Tess',
      custom: { subject: null, heading: null, buttonLabel: null, html: '<p>Hi from {{requester_name}}.</p>' },
    });
    expect(t.html).toContain('Hi from Tess.');
    expect(t.html).toContain(`href="${inviteUrl}"`);
    expect(t.html).not.toContain('{{requester_name}}');
  });

  it('strips javascript: from a custom href using invite_url token via requester_name', () => {
    const inviteUrl = 'https://us.2breeze.app/portal/accept-invite?token=abc';
    const t = buildPortalInviteTemplate({
      to: 'c@a.example',
      inviteUrl,
      inviterName: 'javascript:alert(1)',
      custom: {
        subject: 'Invite',
        heading: 'Invite',
        buttonLabel: null,
        html: '<a href="{{requester_name}}">x</a>',
      },
    });
    expect(t.html).not.toMatch(/href\s*=\s*["']javascript:/i);
    expect(t.html).toContain(`href="${inviteUrl}"`);
    expect(t.html).toContain('<a>x</a>');
  });
});
