/**
 * #8313 W3 (spec 2026-10-19 §5.4): the import options of the shared
 * converter. The defaults' byte identity lives in htmlToText.defaults.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  clampWithMarker,
  cutText,
  htmlToText,
  htmlToTextDetailed,
  MAX_HTML_INPUT_LENGTH,
  type HtmlToTextOptions,
} from './htmlToText';

const links = (html: string) => htmlToText(html, { links: 'inline' });
const quotes = (html: string) => htmlToText(html, { quotes: 'prefix' });
const MARKER = '[cut]';

describe('links: inline', () => {
  it('writes http, https and mailto links as "text <url>"', () => {
    expect(links('<p>See <a href="http://example.com/a">the page</a> now</p>')).toBe('See the page <http://example.com/a> now');
    expect(links('<p><a href="https://example.com/a?b=1&amp;c=2">docs</a>.</p>')).toBe('docs <https://example.com/a?b=1&c=2>.');
    expect(links('<a href="mailto:bob@example.com">Bob</a>')).toBe('Bob <mailto:bob@example.com>');
    expect(links('<a href="HTTPS://Example.com/">Up</a>')).toBe('Up <HTTPS://Example.com/>');
  });

  it('writes only "<url>" when the text is the url or empty', () => {
    expect(links('<p>Go to <a href="https://example.com/x">https://example.com/x</a>.</p>')).toBe('Go to <https://example.com/x>.');
    expect(links('<p>Go to <a href="https://example.com/x">\n  https://example.com/x </a>.</p>')).toBe('Go to <https://example.com/x> .');
    expect(links('<p>Mail <a href="mailto:a@b.co">mailto:a@b.co</a></p>')).toBe('Mail <mailto:a@b.co>');
    expect(links('<p>x<a href="https://example.com/e"></a>y</p>')).toBe('x<https://example.com/e>y');
  });

  it('drops a javascript: (or any other) url and keeps the text', () => {
    expect(links('<p>Click <a href="javascript:alert(1)">here</a> now</p>')).toBe('Click here now');
    expect(links('<a href="JaVaScRiPt:alert(1)">a</a> <a href="java&#x09;script:alert(1)">b</a> <a href=" javascript:x">c</a>')).toBe('a b c');
    expect(links('<a href="data:text/html,x">d</a> <a href="ftp://x.example/f">e</a> <a href="tel:+1555">f</a>')).toBe('d e f');
    expect(links('<a href="vbscript:x">g</a> <a href="file:///etc/passwd">h</a>')).toBe('g h');
  });

  it('drops relative, protocol-relative and fragment urls (no host to point at)', () => {
    expect(links('<a href="/api/v1/x">i</a> <a href="//evil.example/x">j</a> <a href="#top">k</a> <a href="page.html">l</a>')).toBe('i j k l');
    expect(links('<a>m</a> <a href="">n</a> <a name="x">o</a>')).toBe('m n o');
  });

  it('keeps the url text only, never markup, from an escaped href', () => {
    expect(links('<a href="https://example.com/?q=&lt;b&gt;&quot;x&quot;">q</a>')).toBe('q <https://example.com/?q=<b>"x">');
    expect(links('<a href="https://example.com/x">a &lt;b&gt; &amp; c</a>')).toBe('a <b> & c <https://example.com/x>');
  });

  it('puts the url after a link whose content holds layout tags', () => {
    expect(links('<a href="https://example.com"><p>Click</p><p>here</p></a>after')).toBe('Click\n\nhere\n\n<https://example.com> after');
    expect(links('<a href="javascript:x"><div>one</div><div>two</div></a>')).toBe('one\ntwo');
  });

  it('closes an open anchor at the next one (no nesting), each keeping its url', () => {
    expect(links('<a href="https://a.example">A<a href="https://b.example">B</a> tail')).toBe('A <https://a.example>B <https://b.example> tail');
  });

  it('default drops every url', () => {
    expect(htmlToText('<a href="https://example.com/x">docs</a>')).toBe('docs');
    expect(htmlToText('<a href="https://example.com/x">docs</a>', { links: 'drop' })).toBe('docs');
  });
});

describe('quotes: prefix', () => {
  it('prefixes each quoted line with "> " and nests the prefix', () => {
    const html = '<p>Reply</p><blockquote><p>Earlier</p><p>line one<br>line two</p>'
      + '<blockquote><p>Earliest</p></blockquote><p>Back</p></blockquote><p>Bye</p>';
    expect(quotes(html)).toBe([
      'Reply',
      '',
      '> Earlier',
      '>',
      '> line one',
      '> line two',
      '>',
      '> > Earliest',
      '>',
      '> Back',
      '',
      'Bye',
    ].join('\n'));
  });

  it('separates two adjacent quotes with an unquoted blank line', () => {
    expect(quotes('<blockquote>one</blockquote><blockquote>two</blockquote>')).toBe('> one\n\n> two');
    expect(quotes('<blockquote><blockquote>a</blockquote><blockquote>b</blockquote></blockquote>')).toBe('> > a\n>\n> > b');
  });

  it('handles a quote at the start, at the end, empty, unclosed and over-closed', () => {
    expect(quotes('<blockquote>only</blockquote>')).toBe('> only');
    expect(quotes('text<blockquote></blockquote>more')).toBe('text\n\nmore');
    expect(quotes('<blockquote>open<div>still')).toBe('> open\n> still');
    expect(quotes('a</blockquote></blockquote>b<blockquote>c</blockquote>')).toBe('ab\n\n> c');
  });

  it('keeps the flatten default: a blockquote is a paragraph', () => {
    expect(htmlToText('<p>a</p><blockquote><blockquote>b</blockquote></blockquote>')).toBe('a\n\nb');
    expect(htmlToText('<p>a</p><blockquote>b</blockquote>', { quotes: 'flatten' })).toBe('a\n\nb');
  });

  it('does not read sender U+0003/U+0004 as quote boundaries', () => {
    expect(quotes('<p>x&#3;y&#4;z</p><blockquote>q</blockquote>')).toBe('xyz\n\n> q');
  });
});

describe('image resolver', () => {
  it('places the resolver text inline and drops an image it answers null', () => {
    const image = vi.fn((src: string, alt: string) => (src.startsWith('cid:') ? `[image: ${alt || src.slice(4)}]` : null));
    const text = htmlToText(
      '<p>Logo<img src="cid:logo@x" alt="Logo">and <img src="https://track.example/p.gif" width="1"> end <img src="cid:sig"></p>',
      { image },
    );
    expect(text).toBe('Logo [image: Logo] and end [image: sig]');
    expect(image.mock.calls).toEqual([['cid:logo@x', 'Logo'], ['https://track.example/p.gif', ''], ['cid:sig', '']]);
  });

  it('passes raw (entity-decoded) src and alt, and the text comes back literally', () => {
    const image = vi.fn(() => '[image: <a> & "b".png]');
    expect(htmlToText('<img src="/api/v1/ticket_attachment/1/2/3?view=inline&amp;x=1" alt="&quot;q&quot; &lt;r&gt;">', { image }))
      .toBe('[image: <a> & "b".png]');
    expect(image).toHaveBeenCalledWith('/api/v1/ticket_attachment/1/2/3?view=inline&x=1', '"q" <r>');
  });

  it('is not called for images in dropped content, and an empty answer drops the image', () => {
    const image = vi.fn(() => '');
    expect(htmlToText('<style><img src="cid:a"></style><noscript><img src="cid:b"></noscript>x<img src="cid:c">y', { image })).toBe('xy');
    expect(image).toHaveBeenCalledTimes(1);
  });

  it('works inside a link', () => {
    expect(htmlToText('<a href="https://example.com"><img src="cid:a"></a>', { links: 'inline', image: () => '[image: a.png]' }))
      .toBe('[image: a.png] <https://example.com>');
    expect(htmlToText('<a href="https://example.com"><img src="https://t.example/p.gif"></a>', { links: 'inline', image: () => null }))
      .toBe('<https://example.com>');
  });

  it('by default drops images and calls nothing', () => {
    expect(htmlToText('<p>a<img src="cid:a" alt="A">b</p>')).toBe('ab');
  });
});

describe('maxOutputChars and the truncation marker', () => {
  it('clamps at maxOutputChars, silently without a marker', () => {
    const r = htmlToTextDetailed(`<p>${'x'.repeat(300)}</p>`, { maxOutputChars: 100 });
    expect(r).toEqual({ text: 'x'.repeat(100), truncatedInput: false, truncatedOutput: true });
    expect(htmlToTextDetailed('<p>short</p>', { maxOutputChars: 100 })).toEqual({ text: 'short', truncatedInput: false, truncatedOutput: false });
  });

  it('ends a clamped body with a blank line and the marker, which counts toward the limit', () => {
    const r = htmlToTextDetailed(`<p>${'x'.repeat(300)}</p>`, { maxOutputChars: 100, truncationMarker: MARKER });
    expect(r.text).toBe(`${'x'.repeat(100 - MARKER.length - 2)}\n\n${MARKER}`);
    expect(r.text).toHaveLength(100);
    expect(r.truncatedOutput).toBe(true);
  });

  it('a body that fits exactly is left alone', () => {
    const r = htmlToTextDetailed(`<p>${'x'.repeat(100)}</p>`, { maxOutputChars: 100, truncationMarker: MARKER });
    expect(r).toEqual({ text: 'x'.repeat(100), truncatedInput: false, truncatedOutput: false });
  });

  it('clamps at 200,000 with the import marker', () => {
    const marker = '[Truncated during import; the full message is in the source ticket.]';
    const r = htmlToTextDetailed(`<p>${'word '.repeat(50_000)}</p>`, { maxOutputChars: 200_000, truncationMarker: marker });
    expect(r.text).toHaveLength(200_000 - 1); // the cut lands on a space, trimmed before the marker
    expect(r.text.endsWith(`word\n\n${marker}`)).toBe(true);
    expect(r.truncatedOutput).toBe(true);
  });

  it('never cuts a surrogate pair in half', () => {
    const emoji = '\u{1F600}';
    const html = `<p>${'a'.repeat(97)}${emoji}${'b'.repeat(10)}</p>`;
    // The pair sits at 97-98; a 98-char clamp would split it.
    expect(htmlToText(html, { maxOutputChars: 98 })).toBe('a'.repeat(97));
    expect(htmlToText(html, { maxOutputChars: 99 })).toBe(`${'a'.repeat(97)}${emoji}`);
    const marked = htmlToText(html, { maxOutputChars: 98 + MARKER.length + 2, truncationMarker: MARKER });
    expect(marked).toBe(`${'a'.repeat(97)}\n\n${MARKER}`);
    expect(cutText(`ab${emoji}`, 3)).toBe('ab');
  });

  it('marks a body whose input passed the 1,000,000-character cap, and reports it', () => {
    const html = `<p>${'y'.repeat(MAX_HTML_INPUT_LENGTH)}</p><p>LOST</p>`;
    const r = htmlToTextDetailed(html, { maxOutputChars: 2_000_000, truncationMarker: MARKER });
    expect(r.truncatedInput).toBe(true);
    expect(r.truncatedOutput).toBe(false);
    expect(r.text).not.toContain('LOST');
    expect(r.text.endsWith(`y\n\n${MARKER}`)).toBe(true);
    expect(htmlToTextDetailed(html).truncatedInput).toBe(true);
    expect(htmlToTextDetailed('<p>x</p>').truncatedInput).toBe(false);
  });

  it('cuts without the marker when the marker cannot fit', () => {
    expect(clampWithMarker('abcdef', 4, MARKER)).toEqual({ text: 'abcd', truncated: true });
    expect(clampWithMarker('', 100, MARKER, true)).toEqual({ text: MARKER, truncated: false });
    expect(clampWithMarker('abc', 100, MARKER, true)).toEqual({ text: `abc\n\n${MARKER}`, truncated: false });
  });

  it('refuses a maxOutputChars that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => htmlToText('<p>x</p>', { maxOutputChars: bad })).toThrow(RangeError);
    }
  });

  it('clamps the quoted rendering too, and the prefix lines count', () => {
    const html = `<blockquote>${'<p>quoted line</p>'.repeat(1_000)}</blockquote>`;
    const r = htmlToTextDetailed(html, { quotes: 'prefix', maxOutputChars: 1_000, truncationMarker: MARKER });
    expect(r.text.length).toBeLessThanOrEqual(1_000);
    expect(r.text.startsWith('> quoted line\n>\n> quoted line')).toBe(true);
    expect(r.text.endsWith(`\n\n${MARKER}`)).toBe(true);
    expect(r.truncatedOutput).toBe(true);
  });
});

describe('stripControlChars', () => {
  it('strips the C0 controls importedTicket refuses and keeps everything else', () => {
    // The parser turns &#0; into U+FFFD and &#x85; into the Windows-1252 ellipsis, U+2026.
    const html = '<p>a&#0;b&#1;c&#3;d&#8;e&#14;f&#31;g&#127;h&#x85;i</p>';
    expect(htmlToText(html, { stripControlChars: true })).toBe('a\uFFFDbcdefg\u007Fh\u2026i');
    expect(htmlToText('<p>a\u0000b\u0007c\u001Fd\u0085e</p>', { stripControlChars: true })).toBe('abcd\u0085e');
  });

  it('turns tab, VT, FF and line breaks into spaces like any HTML whitespace', () => {
    expect(htmlToText('<p>a&#9;b&#10;c&#11;d&#12;e&#13;f</p>', { stripControlChars: true })).toBe('a b c d e f');
  });

  it('leaves them in by default, as before', () => {
    expect(htmlToText('<p>a&#3;b</p>')).toBe('a\u0003b');
  });

  it('cleans resolver text and urls as well', () => {
    const opts: HtmlToTextOptions = { stripControlChars: true, links: 'inline', image: () => '[image:\u0007 a\nb]' };
    expect(htmlToText('<img src="cid:x"><a href="https://example.com/&#3;x">l</a>', opts)).toBe('[image: a b] l <https://example.com/x>');
  });
});

describe('pathological input stays linear in the new passes', () => {
  // The bound only has to separate linear work from the quadratic shapes
  // these passes would otherwise have (a "> " prefix per level on every line
  // of a deep quote; a link scan restarting at every anchor). Loose on
  // purpose, like the other ReDoS tests here (secretRedaction.test.ts).
  // sanitize-html itself is O(depth²) on deep nesting (htmlparser2 unshifts
  // its open-element stack): 1 MB of nested <div> takes seconds with the
  // defaults already. The depth below keeps the parser cheap so the time
  // measured is the new code's.
  const IMPORT: HtmlToTextOptions = {
    maxOutputChars: 200_000,
    links: 'inline',
    quotes: 'prefix',
    image: () => '[image]',
    truncationMarker: MARKER,
    stripControlChars: true,
  };
  const timed = (html: string) => {
    const start = Date.now();
    const result = htmlToTextDetailed(html, IMPORT);
    return { result, ms: Date.now() - start };
  };

  it('deeply nested blockquotes with text at every level', () => {
    const depth = 25_000;
    const { result, ms } = timed(`${'<blockquote>q'.repeat(depth)}${'</blockquote>'.repeat(depth)}`);
    // Without the output budget this would build ~depth² = 625M characters of
    // prefixes, past the longest string V8 allows: it would throw, not just be slow.
    expect(result.truncatedOutput).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(200_000);
    expect(result.text.startsWith('> q\n>\n> > q\n> >\n> > > q')).toBe(true);
    expect(ms).toBeLessThan(5_000);
  }, 30_000);

  it('1 MB of anchors, images, unclosed attributes and flat quotes', () => {
    const fill = (unit: string) => unit.repeat(Math.ceil(MAX_HTML_INPUT_LENGTH / unit.length));
    for (const html of [
      fill('<a href="https://example.com/x">x'),
      fill('<a href="https://example.com/x">'),
      fill('<a href="'),
      fill('<img src="cid:a">'),
      fill('<blockquote>a</blockquote>'),
      fill('<'),
      fill('&lt;a href=&quot;x&quot;&gt;'),
    ]) {
      const { result, ms } = timed(html);
      expect(result.text.length).toBeLessThanOrEqual(200_000);
      expect(ms).toBeLessThan(5_000);
    }
  }, 60_000);
});
