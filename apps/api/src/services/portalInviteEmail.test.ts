import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { buildPortalInviteTemplate } from './email';

describe('buildPortalInviteTemplate', () => {
  it('includes the invite URL and org name', () => {
    const t = buildPortalInviteTemplate({ to: 'c@a.example', inviteUrl: 'https://us.2breeze.app/portal/accept-invite?token=abc', orgName: 'Acme Co', inviterName: 'Tess', partnerId: null, passwordAllowed: true });
    expect(t.subject).toContain('Acme Co');
    expect(t.html).toContain('https://us.2breeze.app/portal/accept-invite?token=abc');
    expect(t.text).toContain('https://us.2breeze.app/portal/accept-invite?token=abc');
  });
  it('renders a generic subject without an org name', () => {
    const t = buildPortalInviteTemplate({ to: 'c@a.example', inviteUrl: 'https://x/portal/accept-invite?token=1', partnerId: null, passwordAllowed: true });
    expect(t.subject.length).toBeGreaterThan(0);
  });
  it('includes an optional custom message', () => {
    const t = buildPortalInviteTemplate({ to: 'c@a.example', inviteUrl: 'https://x/p?t=1', message: 'Welcome aboard!', partnerId: null, passwordAllowed: true });
    expect(t.html).toContain('Welcome aboard!');
  });

  it('null custom keeps current wording and the server invite URL', () => {
    const inviteUrl = 'https://us.2breeze.app/portal/accept-invite?token=abc';
    const t = buildPortalInviteTemplate({
      to: 'c@a.example',
      inviteUrl,
      orgName: 'Acme Co',
      inviterName: 'Tess',
      partnerId: null,
      passwordAllowed: true,
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
      partnerId: null,
      passwordAllowed: true,
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
      partnerId: null,
      passwordAllowed: true,
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

// Portal registration W4 (#11381) Task 9, spec §5.5: the invite offers the
// sign-in methods the org's effective policy allows. The subject never changes.
describe('buildPortalInviteTemplate — sign-in methods', () => {
  const inviteUrl = 'https://us.2breeze.app/portal/accept-invite?token=abc';
  const microsoftUrl = `${inviteUrl}&method=microsoft`;
  // renderButton / renderLinkRow escape the href, so `&` is `&amp;` in the HTML.
  const microsoftHref = `href="${inviteUrl}&amp;method=microsoft"`;
  const passwordHref = `href="${inviteUrl}"`;
  const base = { to: 'c@a.example', inviteUrl, orgName: 'Acme Co', inviterName: 'Tess', partnerId: null } as const;

  beforeEach(() => { vi.stubEnv('EMAIL_SUPPORT_ADDRESS', ''); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('invite email is unchanged when Microsoft is off', () => {
    const t = buildPortalInviteTemplate({ ...base, passwordAllowed: true });
    expect(t.subject).toBe("You're invited to the Acme Co support portal");
    expect(t.text).toBe([
      "You're invited to the Acme Co support portal.",
      `Set your password: ${inviteUrl}`,
      'This invite link expires in 7 days.',
    ].join('\n'));
    expect(t.html).toContain(`${passwordHref} style=`);
    expect(t.html).toContain('>Set your password</a>');
    expect(t.html).toContain('Set your password to access your support portal.');
    expect(t.html).not.toContain('Microsoft');
  });

  it('invite email offers Microsoft first and keeps a password as the secondary option when both are allowed', () => {
    const t = buildPortalInviteTemplate({ ...base, microsoftUrl, passwordAllowed: true });
    expect(t.subject).toBe("You're invited to the Acme Co support portal");
    expect(t.html).toContain('>Sign in with Microsoft</a>');
    expect(t.html).toContain('>Or set a password</a>');
    expect(t.html.indexOf(microsoftHref)).toBeGreaterThan(-1);
    expect(t.html.indexOf(microsoftHref)).toBeLessThan(t.html.indexOf(passwordHref));
    expect(t.html).not.toContain('>Set your password</a>');
    expect(t.text).toBe([
      "You're invited to the Acme Co support portal.",
      `Sign in with Microsoft: ${microsoftUrl}`,
      `Or set a password: ${inviteUrl}`,
      'This invite link expires in 7 days.',
    ].join('\n'));
  });

  it('invite email offers Microsoft first and hides the password option under sso_only', () => {
    const t = buildPortalInviteTemplate({ ...base, microsoftUrl, passwordAllowed: false });
    expect(t.subject).toBe("You're invited to the Acme Co support portal");
    expect(t.html).toContain('>Sign in with Microsoft</a>');
    expect(t.html).toContain(microsoftHref);
    expect(t.html).not.toContain(passwordHref);
    expect(t.html).not.toMatch(/password/i);
    expect(t.text).not.toMatch(/password/i);
    expect(t.text).toContain(`Sign in with Microsoft: ${microsoftUrl}`);
  });

  it("a partner's custom button label never relabels the Microsoft button; invite_url is the link that works", () => {
    const custom = { subject: null, heading: null, buttonLabel: 'Create your login', html: '<p>Start here: {{invite_url}}</p>' };
    const sso = buildPortalInviteTemplate({ ...base, custom, microsoftUrl, passwordAllowed: false });
    expect(sso.html).toContain('>Sign in with Microsoft</a>');
    expect(sso.html).not.toContain('Create your login');
    expect(sso.html).toContain(`Start here: ${inviteUrl}&amp;method=microsoft`);

    const password = buildPortalInviteTemplate({ ...base, custom, passwordAllowed: true });
    expect(password.html).toContain('>Create your login</a>');
    expect(password.html).toContain(`Start here: ${inviteUrl}<`);
  });
});
