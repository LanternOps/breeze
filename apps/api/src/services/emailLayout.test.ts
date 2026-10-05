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
