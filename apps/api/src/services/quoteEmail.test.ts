import { describe, it, expect } from 'vitest';
import { buildQuoteTemplate } from './quoteEmail';

describe('buildQuoteTemplate', () => {
  it('builds a subject + accept link + html/text', () => {
    const t = buildQuoteTemplate({ quoteNumber: 'Q-2026-0001', partnerName: 'Acme MSP', total: '$1,200.00', acceptUrl: 'https://portal.example.com/quote/TOKEN', expiryDate: '2026-07-01' });
    expect(t.subject).toContain('Q-2026-0001');
    expect(t.subject).toContain('Acme MSP');
    expect(t.html).toContain('https://portal.example.com/quote/TOKEN');
    expect(t.text).toContain('https://portal.example.com/quote/TOKEN');
    expect(t.html).toContain('1,200.00');
  });
});
