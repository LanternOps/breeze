import { describe, expect, it } from 'vitest';
import { renderButton, renderLayout, renderParagraph } from './emailLayout';

/** Every `style="…"` attribute value in the rendered HTML. */
function styleValues(html: string): string[] {
  return [...html.matchAll(/style="([^"]*)"/g)].map(match => match[1]!);
}

describe('email layout inline styles', () => {
  const html = renderLayout({
    title: 'Subject', preheader: 'Preview', heading: 'Heading', footer: 'Footer', brandName: 'Acme IT',
    body: `${renderParagraph('Body')}${renderButton('Open', 'https://example.test/x')}`,
  });

  // A double quote inside a double-quoted style attribute ends the attribute early:
  // the font stack's quoted family names cut every later declaration (font, colour,
  // size, line height) and the body rendered in the client's default serif (P-11).
  it('never ends a style attribute inside the font stack', () => {
    expect(html).not.toMatch(/style="[^"]*font-family:[^";]*"\s*[A-Za-z]/);
    for (const value of styleValues(html)) {
      if (!value.includes('font-family')) continue;
      expect(value).toMatch(/font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Helvetica, Arial, sans-serif/);
    }
  });

  it('keeps the declarations after the font stack inside the attribute', () => {
    const body = styleValues(html).find(value => value.includes('font-size: 15px; line-height: 1.55'));
    expect(body).toBeDefined();
    expect(body).toContain('font-family:');
    expect(styleValues(html).find(value => value.startsWith('margin: 0; padding: 0; background:'))).toContain('color: #1f2937');
  });
});

import { renderLinkRow, renderSummaryTable, renderTermsBlock } from './emailLayout';
describe('billing email blocks', () => {
  it('a summary table is a presentational two-column table with escaped values', () => {
    const html = renderSummaryTable([{ label: 'Amount', value: '$50.00' }, { label: 'Method', value: '<Visa> & co' }]);
    expect(html).toMatch(/^<table role="presentation"/);
    expect(html).toContain('>Amount</td>');
    expect(html).toContain('&lt;Visa&gt; &amp; co');
    expect(styleValues(html).every(value => !value.includes('"'))).toBe(true);
    expect(renderSummaryTable([])).toBe('');
  });
  it('a link row joins real links with a separator and escapes the URLs', () => {
    const html = renderLinkRow([{ label: 'Skip this payment', url: 'https://x.test/a?b=1&c=2' }, { label: 'Stop', url: 'https://x.test/s' }]);
    expect(html).toContain('href="https://x.test/a?b=1&amp;c=2"');
    expect(html).toContain('&nbsp;·&nbsp;');
    expect(renderLinkRow([])).toBe('');
  });
  it('a terms block titles its muted paragraphs', () => {
    const html = renderTermsBlock('Your authorization', ['You accepted these terms on October 5, 2026.', 'I authorize <MSP>.']);
    expect(html).toContain('Your authorization');
    expect(html).toContain('I authorize &lt;MSP&gt;.');
  });
  it('the layout carries a head style so partner paragraphs get the rhythm', () => {
    expect(renderLayout({ title: 't', preheader: 'p', body: '<p>x</p>' })).toMatch(/<style>[^<]*p\s*\{[^}]*margin/);
  });
});
