import { describe, it, expect } from 'vitest';
import { sanitizeRichTextHtml } from './richTextSanitize';

describe('sanitizeRichTextHtml', () => {
  it('preserves the allowed subset', () => {
    const input = '<h3>Terms</h3><p><strong>Bold</strong> and <em>italic</em> and <u>underline</u></p><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol><p>line<br>break</p>';
    expect(sanitizeRichTextHtml(input)).toBe(input.replace('<br>', '<br />'));
  });
  it('strips script/style/iframe and event handlers', () => {
    expect(sanitizeRichTextHtml('<p onclick="x()">hi</p><script>evil()</script><style>p{}</style><iframe src="x"></iframe>'))
      .toBe('<p>hi</p>');
  });
  it('strips javascript: hrefs but keeps https links with forced rel', () => {
    expect(sanitizeRichTextHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeRichTextHtml('<a href="https://example.com">x</a>'))
      .toBe('<a href="https://example.com" rel="noopener noreferrer" target="_blank">x</a>');
  });
  it('downgrades disallowed headings/divs to their text content wrapped as-is', () => {
    expect(sanitizeRichTextHtml('<h1>big</h1><div>plain</div>')).toBe('big plain'.replace(' ', '')); // see impl: text preserved, tags dropped
  });
  it('strips inline styles and classes', () => {
    expect(sanitizeRichTextHtml('<p style="color:red" class="x">hi</p>')).toBe('<p>hi</p>');
  });
  it('strips protocol-relative (//host) hrefs — no scheme allowlist bypass', () => {
    // `//evil.example` navigates off-origin under the page's own scheme; it must
    // not survive as an href, and must not receive the forced rel/target either.
    expect(sanitizeRichTextHtml('<a href="//evil.example">x</a>')).toBe('<a>x</a>');
    expect(sanitizeRichTextHtml('<a href="//evil.example/path?q=1">x</a>')).toBe('<a>x</a>');
  });
});
