import { describe, it, expect } from 'vitest';
import { buildPortalInviteTemplate } from './email';

describe('buildPortalInviteTemplate', () => {
  it('includes the invite URL and org name', () => {
    const t = buildPortalInviteTemplate({ to: 'c@a.example', inviteUrl: 'https://us.2breeze.app/portal/accept-invite?token=abc', orgName: 'Acme Co', inviterName: 'Tess' });
    expect(t.subject).toContain('Acme Co');
    expect(t.html).toContain('https://us.2breeze.app/portal/accept-invite?token=abc');
    expect(t.text).toContain('https://us.2breeze.app/portal/accept-invite?token=abc');
  });
  it('renders a generic subject without an org name', () => {
    const t = buildPortalInviteTemplate({ to: 'c@a.example', inviteUrl: 'https://x/portal/accept-invite?token=1' });
    expect(t.subject.length).toBeGreaterThan(0);
  });
  it('includes an optional custom message', () => {
    const t = buildPortalInviteTemplate({ to: 'c@a.example', inviteUrl: 'https://x/p?t=1', message: 'Welcome aboard!' });
    expect(t.html).toContain('Welcome aboard!');
  });
});
