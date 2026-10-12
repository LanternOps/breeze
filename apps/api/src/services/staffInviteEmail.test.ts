import { describe, it, expect } from 'vitest';
import { buildStaffInviteTemplate } from './email';

const inviteUrl = 'https://us.2breeze.app/accept-invite?token=abc';

describe('buildStaffInviteTemplate', () => {
  it('null custom keeps the historical wording, button and URL', () => {
    const t = buildStaffInviteTemplate({ to: 'a@b.test', name: 'Sam', inviterName: 'Tess', orgName: 'Acme Co', inviteUrl, custom: null });
    expect(t.subject).toBe('Tess invited you to Acme Co on Breeze');
    expect(t.html).toContain('Join Acme Co');
    expect(t.html).toContain('Hi Sam,');
    expect(t.html).toContain('Tess invited you to Acme Co on Breeze.');
    expect(t.html).toContain('Accept invitation');
    expect(t.html).toContain('expires in 7 days');
    expect(t.html).toContain(`href="${inviteUrl}"`);
    expect(t.text).toContain(inviteUrl);
    expect(t.html).toContain('Breeze RMM');
  });

  it('without an org keeps the generic subject and heading', () => {
    const t = buildStaffInviteTemplate({ to: 'a@b.test', inviterName: 'Tess', inviteUrl });
    expect(t.subject).toBe('Tess invited you to Breeze');
    expect(t.html).toContain('You are invited');
    expect(t.html).toContain('Hi there,');
    expect(t.html).toContain('Tess invited you on Breeze.');
  });

  it('without an inviter falls back to "A teammate"', () => {
    const t = buildStaffInviteTemplate({ to: 'a@b.test', inviteUrl });
    expect(t.subject).toBe('A teammate invited you to Breeze');
  });

  it('applies a partner override to subject, heading, button label and body', () => {
    const t = buildStaffInviteTemplate({
      to: 'a@b.test', name: 'Sam', inviterName: 'Tess', orgName: 'Acme Co', inviteUrl, partnerName: 'Fix-It MSP',
      custom: {
        subject: 'Einladung von {{inviter_name}} zu {{org_name}}',
        heading: 'Willkommen {{name}}',
        buttonLabel: 'Einladung annehmen',
        html: '<p>Hallo {{name}}, gültig {{expires_days}} Tage.</p><p>{{cta_button}}</p>',
      },
    });
    expect(t.subject).toBe('Einladung von Tess zu Acme Co');
    expect(t.html).toContain('Willkommen Sam');
    expect(t.html).toContain('Einladung annehmen');
    expect(t.html).toContain('Hallo Sam, gültig 7 Tage.');
    expect(t.html).toContain(`href="${inviteUrl}"`);
    expect(t.html).not.toContain('Accept invitation');
    expect(t.text).toContain(inviteUrl);
  });

  it('brands the footer with the partner name, defaulting to Breeze RMM', () => {
    const branded = buildStaffInviteTemplate({ to: 'a@b.test', inviteUrl, partnerName: 'Fix-It MSP' });
    expect(branded.html).toContain('Fix-It MSP');
    expect(branded.html).not.toContain('Breeze RMM');
    expect(buildStaffInviteTemplate({ to: 'a@b.test', inviteUrl }).html).toContain('Breeze RMM');
  });

  it('escapes variables and strips a javascript: href built from a variable', () => {
    const t = buildStaffInviteTemplate({
      to: 'a@b.test', inviterName: 'javascript:alert(1)', inviteUrl,
      custom: { subject: 'Hi', heading: 'Hi', buttonLabel: null, html: '<a href="{{inviter_name}}">x</a><b>{{name}}</b>' },
      name: '<script>x</script>',
    });
    expect(t.html).not.toMatch(/href\s*=\s*["']javascript:/i);
    expect(t.html).not.toContain('<script>');
    expect(t.html).toContain(`href="${inviteUrl}"`);
  });
});
