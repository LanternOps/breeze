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

  it('honors a subject override, falling back to the standard subject when blank', () => {
    const base = { quoteNumber: 'Q-1', partnerName: 'Acme', total: '$1', acceptUrl: 'https://x.example/q/t' };
    expect(buildQuoteTemplate({ ...base, subject: 'Your new workstations' }).subject).toBe('Your new workstations');
    expect(buildQuoteTemplate({ ...base, subject: '   ' }).subject).toBe('Proposal Q-1 from Acme');
  });

  it('drops the "PDF copy is attached" copy when the PDF is not attached', () => {
    const base = { quoteNumber: 'Q-1', partnerName: 'Acme', total: '$1', acceptUrl: 'https://x.example/q/t' };
    const withPdf = buildQuoteTemplate({ ...base, pdfAttached: true });
    expect(withPdf.html).toContain('A PDF copy is attached.');
    expect(withPdf.text).toContain('A PDF copy is attached.');
    const withoutPdf = buildQuoteTemplate({ ...base, pdfAttached: false });
    expect(withoutPdf.html).not.toContain('PDF copy is attached');
    expect(withoutPdf.text).not.toContain('PDF copy is attached');
  });

  it('renders the partner signature (escaped, multi-line) in html and text', () => {
    const t = buildQuoteTemplate({
      quoteNumber: 'Q-1', partnerName: 'Acme', total: '$1', acceptUrl: 'https://x.example/q/t',
      signature: 'Todd H.\nOliveTech <support>',
    });
    expect(t.html).toContain('Todd H.<br>OliveTech &lt;support&gt;');
    expect(t.text).toContain('Todd H.\nOliveTech <support>');
  });

  it('brands the layout as the MSP, not the platform', () => {
    const t = buildQuoteTemplate({ quoteNumber: 'Q-2026-0001', partnerName: 'Acme MSP', total: '$1,200.00', acceptUrl: 'https://portal.example.com/quote/TOKEN' });
    // The faint brand line under the card must show the MSP the customer
    // actually buys from — "Breeze RMM" would read as a stranger's email.
    expect(t.html).not.toContain('Breeze RMM');
    expect(t.html).toContain('Acme MSP');
  });
});
