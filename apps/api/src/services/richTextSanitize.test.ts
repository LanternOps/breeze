import { describe, it, expect } from 'vitest';
import {
  sanitizeRichTextHtml,
  sanitizeInlineRichText,
  sanitizePlainText,
  sanitizeRichTextHtmlWithReport,
  sanitizeInlineRichTextWithReport,
  sanitizePlainTextWithReport,
  richTextStripWarning,
} from './richTextSanitize';

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

describe('sanitizeInlineRichText', () => {
  it('keeps inline marks, strips block tags', () => {
    expect(sanitizeInlineRichText('<strong>a</strong> <em>b</em><br><u>c</u>')).toBe('<strong>a</strong> <em>b</em><br /><u>c</u>');
    expect(sanitizeInlineRichText('<p>x</p><ul><li>y</li></ul><table><tr><td>z</td></tr></table>')).toBe('xyz');
  });
  it('applies the hardened link rules', () => {
    expect(sanitizeInlineRichText('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript');
    expect(sanitizeInlineRichText('<a href="https://a.b">x</a>')).toContain('rel="noopener noreferrer"');
  });
});

// Issue #3520: the sanitizer used to discard out-of-subset tags without telling
// anyone, so a write returned 200 with the author's content gone. The reporting
// variants name what was dropped without changing what is produced.
describe('loss reporting (#3520)', () => {
  it('sanitizeRichTextHtmlWithReport names every disallowed tag it removed', () => {
    const r = sanitizeRichTextHtmlWithReport('<p>keep</p><blockquote><h1>x</h1></blockquote><table><tr><td>c</td></tr></table>');
    expect(r.removedTags).toEqual(['blockquote', 'h1', 'table', 'td', 'tr']);
  });

  it('reports the same tag once and in sorted order however often it appears', () => {
    expect(sanitizeRichTextHtmlWithReport('<div>a</div><div>b</div><span>c</span>').removedTags)
      .toEqual(['div', 'span']);
  });

  it('lowercases tag names so <TABLE> and <table> report identically', () => {
    expect(sanitizeRichTextHtmlWithReport('<TABLE><TR><TD>x</TD></TR></TABLE>').removedTags)
      .toEqual(['table', 'td', 'tr']);
  });

  it('produces html byte-identical to the silent variant', () => {
    const inputs = [
      '<p>hi</p><script>evil()</script><div>d</div>',
      '<a href="javascript:alert(1)">x</a>',
      '<p style="color:red" class="x">hi</p>',
      '<h1>big</h1><table><tr><td>c</td></tr></table>',
      '',
    ];
    for (const input of inputs) {
      expect(sanitizeRichTextHtmlWithReport(input).html).toBe(sanitizeRichTextHtml(input));
      expect(sanitizeInlineRichTextWithReport(input).html).toBe(sanitizeInlineRichText(input));
      expect(sanitizePlainTextWithReport(input).html).toBe(sanitizePlainText(input));
    }
  });

  it('reports tag removal only — NOT stripped attributes or a rejected href scheme', () => {
    // style/class are dropped and `javascript:` is neutered, but no content is
    // lost, so flagging them would make every Word paste look alarming.
    expect(sanitizeRichTextHtmlWithReport('<p style="color:red" class="x">hi</p>').removedTags).toEqual([]);
    expect(sanitizeRichTextHtmlWithReport('<a href="javascript:alert(1)">x</a>').removedTags).toEqual([]);
    expect(sanitizeRichTextHtmlWithReport('<a href="//evil.example">x</a>').removedTags).toEqual([]);
  });

  it('reports nothing for html already inside the subset, and nothing for empty input', () => {
    expect(sanitizeRichTextHtmlWithReport('<p>a <strong>b</strong> <a href="https://a.b">c</a></p>').removedTags).toEqual([]);
    expect(sanitizeRichTextHtmlWithReport('').removedTags).toEqual([]);
    expect(sanitizeRichTextHtmlWithReport('plain text, no markup').removedTags).toEqual([]);
  });

  it('uses the inline profile for the inline reporter — block tags count as removed there', () => {
    const r = sanitizeInlineRichTextWithReport('<p>x</p><ul><li>y</li></ul><strong>ok</strong>');
    expect(r.removedTags).toEqual(['li', 'p', 'ul']);
    expect(r.html).toBe('xy<strong>ok</strong>');
  });

  it('treats every tag as removed in the plain-text profile', () => {
    expect(sanitizePlainTextWithReport('<strong>a</strong>b').removedTags).toEqual(['strong']);
    expect(sanitizePlainTextWithReport('just words').removedTags).toEqual([]);
  });

  it('collector state does not leak between calls', () => {
    expect(sanitizeRichTextHtmlWithReport('<table>x</table>').removedTags).toEqual(['table']);
    expect(sanitizeRichTextHtmlWithReport('<p>clean</p>').removedTags).toEqual([]);
  });

  it('richTextStripWarning returns null when nothing was removed and a warning when something was', () => {
    expect(richTextStripWarning('content.html', { html: '', removedTags: [] })).toBeNull();
    expect(richTextStripWarning('content.html', { html: '', removedTags: ['table'] })).toEqual({
      code: 'UNSUPPORTED_HTML_TAGS_REMOVED',
      field: 'content.html',
      removedTags: ['table'],
    });
  });
});
