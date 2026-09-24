import { describe, it, expect } from 'vitest';
import { emailTemplateFieldDefaults } from '@breeze/shared';
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

  it('null custom keeps current wording and the server accept URL', () => {
    const acceptUrl = 'https://portal.example.com/quote/TOKEN';
    const t = buildQuoteTemplate({
      quoteNumber: 'Q-2026-0001',
      partnerName: 'Acme MSP',
      total: '$1,200.00',
      acceptUrl,
      expiryDate: '2026-07-01',
      custom: null,
    });
    expect(t.html).toContain('Hello,');
    expect(t.html).toContain('proposal <strong>Q-2026-0001</strong>');
    expect(t.html).toContain('Q-2026-0001');
    expect(t.html).toContain('This proposal is valid until');
    expect(t.html).toContain(`href="${acceptUrl}"`);
    expect(t.text).toContain(acceptUrl);
  });

  it('does not duplicate catalog PDF and expiry lines on custom html', () => {
    const t = buildQuoteTemplate({
      quoteNumber: 'Q-1',
      partnerName: 'Acme',
      total: '$1',
      acceptUrl: 'https://x.example/q/t',
      expiryDate: '2026-07-01',
      custom: {
        subject: null,
        heading: null,
        buttonLabel: null,
        html: emailTemplateFieldDefaults('quote_send').html.replace('Hi there', 'Hello'),
      },
    });
    expect(t.html.match(/A PDF copy is attached\./g)).toHaveLength(1);
    expect(t.html.match(/This proposal is valid until/g)).toHaveLength(1);
  });

  it('uses the proposal title and customer name when the quote has them', () => {
    const t = buildQuoteTemplate({
      quoteNumber: 'Q-2026-0001', partnerName: 'Acme MSP', total: '$1,200.00',
      acceptUrl: 'https://portal.example.com/quote/TOKEN',
      quoteTitle: 'Office Network Refresh', customerName: 'Contoso & Co',
    });
    expect(t.subject).toBe('Office Network Refresh — proposal from Acme MSP');
    expect(t.html).toMatch(/<h1[^>]*>Office Network Refresh<\/h1>/);
    expect(t.html).toContain('<strong>Office Network Refresh</strong> (proposal Q-2026-0001)');
    expect(t.html).toContain('work with Contoso &amp; Co.');
    expect(t.text).toContain('Office Network Refresh (proposal Q-2026-0001)');
    expect(t.text).toContain('work with Contoso & Co.');
  });

  it('falls back to the proposal number and "you" when title and customer are blank', () => {
    const t = buildQuoteTemplate({
      quoteNumber: 'Q-1', partnerName: 'Acme', total: '$1', acceptUrl: 'https://x.example/q/t',
      quoteTitle: '  ', customerName: '',
    });
    expect(t.subject).toBe('Proposal Q-1 from Acme');
    expect(t.html).toMatch(/<h1[^>]*>Proposal Q-1<\/h1>/);
    expect(t.html).toContain('proposal <strong>Q-1</strong>');
    expect(t.html).toContain('work with you.');
    expect(t.html).not.toContain('<strong></strong>');
    expect(t.text).toContain('work with you.');
  });

  it('escapes a markup title exactly once in heading and body', () => {
    const t = buildQuoteTemplate({
      quoteNumber: 'Q-1', partnerName: 'Acme', total: '$1', acceptUrl: 'https://x.example/q/t',
      quoteTitle: '<b>R&D</b> Refresh',
    });
    expect(t.html).toMatch(/<h1[^>]*>&lt;b&gt;R&amp;D&lt;\/b&gt; Refresh<\/h1>/);
    expect(t.html).not.toContain('<b>R&D');
    expect(t.html).not.toContain('&amp;amp;');
  });

  it('keeps a multi-line title on one subject line', () => {
    const t = buildQuoteTemplate({
      quoteNumber: 'Q-1', partnerName: 'Acme', total: '$1', acceptUrl: 'https://x.example/q/t',
      quoteTitle: 'Line1\nLine2',
    });
    expect(t.subject).not.toMatch(/[\r\n]/);
    expect(t.subject).toBe('Line1 Line2 — proposal from Acme');
  });

  it('exposes quote_title and org_name to custom templates', () => {
    const t = buildQuoteTemplate({
      quoteNumber: 'Q-1', partnerName: 'Acme', total: '$1', acceptUrl: 'https://x.example/q/t',
      quoteTitle: 'New Laptops', customerName: 'Contoso',
      custom: { subject: '{{quote_title}} for {{org_name}}', heading: null, buttonLabel: null, html: '<p>{{quote_title}} / {{org_name}}</p>' },
    });
    expect(t.subject).toBe('New Laptops for Contoso');
    expect(t.html).toContain('New Laptops / Contoso');
  });

  it('custom html substitutes quote_number and keeps the server accept URL', () => {
    const acceptUrl = 'https://portal.example.com/quote/TOKEN';
    const t = buildQuoteTemplate({
      quoteNumber: 'Q-2026-0001',
      partnerName: 'Acme MSP',
      total: '$1,200.00',
      acceptUrl,
      custom: { subject: null, heading: null, buttonLabel: null, html: '<p>Proposal {{quote_number}} is ready.</p>' },
    });
    expect(t.html).toContain('Proposal Q-2026-0001 is ready.');
    expect(t.html).toContain(`href="${acceptUrl}"`);
    expect(t.html).not.toContain('{{quote_number}}');
  });

  it('strips javascript: from a custom href using quote_number', () => {
    const acceptUrl = 'https://portal.example.com/quote/TOKEN';
    const t = buildQuoteTemplate({
      quoteNumber: 'javascript:alert(1)',
      partnerName: 'Acme MSP',
      total: '$1',
      acceptUrl,
      custom: {
        subject: 'Proposal',
        heading: 'Proposal',
        buttonLabel: null,
        html: '<a href="{{quote_number}}">x</a>',
      },
    });
    expect(t.html).not.toMatch(/href\s*=\s*["']javascript:/i);
    expect(t.html).toContain(`href="${acceptUrl}"`);
    expect(t.html).toContain('<a>x</a>');
  });

  it('keeps the per-send note and signature around custom html', () => {
    const acceptUrl = 'https://x.example/q/t';
    const t = buildQuoteTemplate({
      quoteNumber: 'Q-1',
      partnerName: 'Acme',
      total: '$1',
      acceptUrl,
      message: 'Please review this week.',
      signature: 'Todd H.',
      custom: { subject: null, heading: null, buttonLabel: null, html: '<p>Custom {{quote_number}}</p>' },
    });
    expect(t.html).toContain('Custom Q-1');
    expect(t.html).toContain('Please review this week.');
    expect(t.html).toContain('Todd H.');
    expect(t.html).toContain(`href="${acceptUrl}"`);
  });
});
