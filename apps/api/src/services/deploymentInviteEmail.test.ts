import { describe, it, expect } from 'vitest';
import { buildDeploymentInviteEmail } from './deploymentInviteEmail';

describe('buildDeploymentInviteEmail', () => {
  it('includes install URL, org name, admin email, and strips HTML from custom message', () => {
    const { subject, html, text } = buildDeploymentInviteEmail({
      orgName: 'Acme',
      adminEmail: 'alex@acme.com',
      installUrl: 'https://us.2breeze.app/i/ABC12345',
      customMessage: '<<script>alert(1)</script>>Please install ASAP.',
    });
    expect(subject).toContain('Acme');
    expect(subject).toMatch(/install/i);
    expect(html).toContain('https://us.2breeze.app/i/ABC12345');
    expect(html).toContain('alex@acme.com');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Please install ASAP.');
    expect(text).toContain('https://us.2breeze.app/i/ABC12345');
    expect(text).toContain('Please install ASAP.');
    expect(text).not.toContain('<script>');
    // Overlapping/nested tag regression: a single non-global strip of <[^>]+>
    // would leave a residual '>' on the plaintext path.
    expect(text).not.toMatch(/[<>]/);
  });

  it('works without a customMessage', () => {
    const { html, text } = buildDeploymentInviteEmail({
      orgName: 'Acme',
      adminEmail: 'alex@acme.com',
      installUrl: 'https://us.2breeze.app/i/ABC12345',
    });
    expect(html).toContain('https://us.2breeze.app/i/ABC12345');
    expect(text).toContain('https://us.2breeze.app/i/ABC12345');
    expect(html).toMatch(/install/i);
    expect(text).toMatch(/install/i);
  });

  it('clamps custom message to 500 chars after HTML strip', () => {
    const long = 'a'.repeat(600);
    const { text } = buildDeploymentInviteEmail({
      orgName: 'Acme',
      adminEmail: 'alex@acme.com',
      installUrl: 'https://us.2breeze.app/i/ABC12345',
      customMessage: long,
    });
    // Anything longer than 500 chars of 'a' indicates clamp did not apply.
    const runs = text.match(/a{500,}/g) ?? [];
    for (const run of runs) {
      expect(run.length).toBeLessThanOrEqual(500);
    }
  });

  it('escapes HTML metacharacters in org name and admin email', () => {
    const { html } = buildDeploymentInviteEmail({
      orgName: 'Ac<me> & "Co"',
      adminEmail: 'al<>@acme.com',
      installUrl: 'https://example/i/abc',
    });
    expect(html).not.toContain('<me>');
    expect(html).toContain('Ac&lt;me&gt;');
    expect(html).toContain('al&lt;&gt;@acme.com');
  });
});
