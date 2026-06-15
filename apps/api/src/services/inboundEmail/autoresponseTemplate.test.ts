import { describe, it, expect } from 'vitest';
import { buildAutoresponseEmail } from './autoresponseTemplate';

describe('buildAutoresponseEmail', () => {
  it('includes the ticket token in subject and body', () => {
    const m = buildAutoresponseEmail({ internalNumber: 'T-2026-0001', subject: 'printer down' });
    expect(m.subject).toBe('[T-2026-0001] We received your request: printer down');
    expect(m.html).toContain('T-2026-0001');
  });
  it('degrades gracefully without an internal number (token-less subject)', () => {
    const m = buildAutoresponseEmail({ internalNumber: null, subject: 'printer' });
    expect(m.subject).toBe('We received your request: printer');
    expect(m.html).toContain('your request');
  });
});
