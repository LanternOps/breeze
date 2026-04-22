import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('buildActivationEmail', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('includes activation URL and org name in both html and text', async () => {
    const { buildActivationEmail } = await import('./activationEmail');
    const { subject, html, text } = buildActivationEmail({
      activationUrl: 'https://us.2breeze.app/activate/abc',
      orgName: 'Acme',
    });
    expect(subject).toMatch(/activate/i);
    expect(subject).toContain('Acme');
    expect(html).toContain('https://us.2breeze.app/activate/abc');
    expect(text).toContain('https://us.2breeze.app/activate/abc');
    expect(html).toContain('Acme');
  });

  it('escapes HTML special chars in org name', async () => {
    const { buildActivationEmail } = await import('./activationEmail');
    const { html } = buildActivationEmail({ activationUrl: 'x', orgName: '<script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('sendActivationEmail', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('builds the template and calls the email service with the admin email', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./email', () => ({ getEmailService: () => ({ sendEmail: send }) }));
    vi.doMock('../db', () => ({
      db: {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ name: 'Acme' }]),
            }),
          }),
        }),
      },
    }));
    process.env.PUBLIC_ACTIVATION_BASE_URL = 'https://us.2breeze.app';
    const { sendActivationEmail } = await import('./activationEmail');
    await sendActivationEmail({ to: 'alex@acme.com', rawToken: 'abc123', partnerId: 'p1' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'alex@acme.com',
      subject: expect.stringContaining('Acme'),
      html: expect.stringContaining('https://us.2breeze.app/activate/abc123'),
    }));
  });

  it('throws a clear error when the email service is not configured', async () => {
    vi.doMock('./email', () => ({ getEmailService: () => null }));
    vi.doMock('../db', () => ({
      db: {
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => Promise.resolve([{ name: 'Acme' }]) }),
          }),
        }),
      },
    }));
    process.env.PUBLIC_ACTIVATION_BASE_URL = 'https://us.2breeze.app';
    const { sendActivationEmail } = await import('./activationEmail');
    await expect(
      sendActivationEmail({ to: 'alex@acme.com', rawToken: 'x', partnerId: 'p1' }),
    ).rejects.toThrow(/email service/i);
  });
});
