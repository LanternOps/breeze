import { describe, it, expect } from 'vitest';
import { buildAutoresponseEmail } from './autoresponseTemplate';

describe('buildAutoresponseEmail', () => {
  it('falls back to the exact default when no custom template is set', () => {
    const out = buildAutoresponseEmail({ internalNumber: 'T-2026-0001', subject: 'Printer' });
    expect(out.subject).toBe('[T-2026-0001] We received your request: Printer');
    expect(out.html).toContain('opened ticket <strong>T-2026-0001</strong>');
  });

  it('degrades the default subject token when internalNumber is null', () => {
    const out = buildAutoresponseEmail({ internalNumber: null, subject: 'Printer' });
    expect(out.subject).toBe('We received your request: Printer');
    expect(out.html).toContain('<strong>your request</strong>');
  });

  it('renders a custom subject and body with substituted variables', () => {
    const out = buildAutoresponseEmail({
      internalNumber: 'T-2026-0002',
      subject: 'VPN',
      custom: { subject: 'Re: {{ticket_subject}} ({{ticket_number}})', body: 'Hi {{requester_name}}' },
      vars: { ticket_subject: 'VPN', ticket_number: 'T-2026-0002', requester_name: 'Ada' },
    });
    expect(out.subject).toBe('Re: VPN (T-2026-0002)');
    expect(out.html).toContain('Hi Ada');
  });

  it('HTML-escapes variable values in the custom body (no injection)', () => {
    const out = buildAutoresponseEmail({
      internalNumber: 'T-2026-0003',
      subject: 'x',
      custom: { subject: null, body: 'Hello {{requester_name}}' },
      vars: { requester_name: '<script>alert(1)</script>' },
    });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('uses the default subject when only a custom body is set', () => {
    const out = buildAutoresponseEmail({
      internalNumber: 'T-2026-0004',
      subject: 'x',
      custom: { subject: null, body: 'Custom body' },
      vars: {},
    });
    expect(out.subject).toBe('[T-2026-0004] We received your request: x');
    expect(out.html).toContain('Custom body');
  });
});
