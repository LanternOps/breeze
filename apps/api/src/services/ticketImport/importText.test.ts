/**
 * #8313 W3 (spec 2026-10-19 §5.4, §6.5): the importer's body helpers. Their
 * output must always pass importedTicket's text rule (F2) and the 200,000
 * ImportedComment limit, and a cut body must say so.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { importedTicketSchema } from './importedTicket';
import {
  htmlForImport,
  IMPORT_TEXT_MAX_CHARS,
  IMPORT_TRUNCATION_MARKER,
  plainTextForImport,
  stripRefusedControlChars,
} from './importText';

const at = new Date('2026-01-01T00:00:00Z');

/** importedTicket's verdict on `content` as a comment and as the description. */
function accepted(content: string): boolean {
  return importedTicketSchema.safeParse({
    sourceId: 't-1',
    orgId: '00000000-0000-4000-8000-000000000001',
    createdAt: at,
    updatedAt: at,
    subject: 'Subject',
    description: content,
    priority: 'normal',
    source: 'email',
    requester: { name: 'Ada', email: 'ada@example.com' },
    finalStatus: 'open',
    comments: [{ sourceId: 'c-1', createdAt: at, isPublic: true, author: { kind: 'requester', name: 'Ada' }, content }],
  }).success;
}

describe('the importedTicket oracle (self-check)', () => {
  it('accepts plain text at the limit and refuses a control character or one more character', () => {
    expect(accepted('x'.repeat(IMPORT_TEXT_MAX_CHARS))).toBe(true);
    expect(accepted('x'.repeat(IMPORT_TEXT_MAX_CHARS + 1))).toBe(false);
    expect(accepted('a\u0003b')).toBe(false);
  });
});

describe('stripRefusedControlChars (W5 review 15)', () => {
  it('removes exactly the characters importedTicket refuses: one rule', () => {
    for (let code = 0; code < 0x20; code += 1) {
      const c = String.fromCharCode(code);
      expect(stripRefusedControlChars(`a${c}b`) === 'ab').toBe(!accepted(`a${c}b`));
    }
    expect(stripRefusedControlChars('tab\tline\ncr\r')).toBe('tab\tline\ncr\r');
  });
});

describe('plainTextForImport', () => {
  it('normalizes CRLF and CR to LF and keeps everything else, untrimmed', () => {
    expect(plainTextForImport('  one\r\ntwo\rthree\n\nfour\r\n\r\n  ')).toEqual({ text: '  one\ntwo\nthree\n\nfour\n\n  ', truncated: false });
    expect(plainTextForImport('a\r\r\nb')).toEqual({ text: 'a\n\nb', truncated: false });
    expect(plainTextForImport('')).toEqual({ text: '', truncated: false });
  });

  it('strips exactly the control characters importedTicket refuses', () => {
    for (let code = 0; code <= 0xa0; code += 1) {
      const ch = String.fromCharCode(code);
      const { text } = plainTextForImport(`a${ch}b`);
      expect(accepted(text), `U+${code.toString(16)}`).toBe(true);
      // Kept unless importedTicket refuses it; CR becomes LF.
      const expected = code === 0x0d ? 'a\nb' : accepted(`a${ch}b`) ? `a${ch}b` : 'ab';
      expect(text, `U+${code.toString(16)}`).toBe(expected);
    }
  });

  it('clamps at 200,000 with the marker, which counts toward the limit', () => {
    const r = plainTextForImport('x'.repeat(IMPORT_TEXT_MAX_CHARS + 1));
    expect(r.truncated).toBe(true);
    expect(r.text).toHaveLength(IMPORT_TEXT_MAX_CHARS);
    expect(r.text.endsWith(`x\n\n${IMPORT_TRUNCATION_MARKER}`)).toBe(true);
    expect(accepted(r.text)).toBe(true);
    expect(plainTextForImport('x'.repeat(IMPORT_TEXT_MAX_CHARS))).toEqual({ text: 'x'.repeat(IMPORT_TEXT_MAX_CHARS), truncated: false });
  });

  it('clamps after normalizing, so CRLF and control characters do not count', () => {
    const body = 'ab\r\n\u0001'.repeat(10);
    expect(plainTextForImport(body, { maxOutputChars: 30 })).toEqual({ text: 'ab\n'.repeat(10), truncated: false });
  });

  it('honours maxOutputChars, never cuts a surrogate pair, and trims before the marker', () => {
    const room = 20 - IMPORT_TRUNCATION_MARKER.length - 2;
    expect(room).toBeLessThan(0); // the marker cannot fit in 20: a plain cut
    expect(plainTextForImport('abcdefghijklmnopqrstuvwxyz', { maxOutputChars: 20 })).toEqual({ text: 'abcdefghijklmnopqrst', truncated: true });
    const max = IMPORT_TRUNCATION_MARKER.length + 2 + 10;
    expect(plainTextForImport(`${'a'.repeat(9)}\u{1F600}${'b'.repeat(100)}`, { maxOutputChars: max }).text)
      .toBe(`${'a'.repeat(9)}\n\n${IMPORT_TRUNCATION_MARKER}`);
    expect(plainTextForImport(`${'a'.repeat(5)}     ${'b'.repeat(100)}`, { maxOutputChars: max }).text)
      .toBe(`aaaaa\n\n${IMPORT_TRUNCATION_MARKER}`);
  });

  it('refuses a maxOutputChars that is not a positive integer', () => {
    expect(() => plainTextForImport('x', { maxOutputChars: 0 })).toThrow(RangeError);
    expect(() => plainTextForImport('x', { maxOutputChars: 2.5 })).toThrow(RangeError);
  });
});

describe('htmlForImport', () => {
  it('applies the import options: inline links, prefixed quotes, the image resolver', () => {
    const image = vi.fn((src: string) => (src.startsWith('cid:') ? `[image: ${src.slice(4)}]` : null));
    const html = '<div>Hi,<br>see <a href="https://kb.example/1">KB 1</a> and <a href="javascript:void(0)">this</a>.'
      + '<img src="cid:shot.png"><img src="https://track.example/p.gif"></div>'
      + '<blockquote><p>On Monday Bob wrote:</p><blockquote>It is down.</blockquote></blockquote>';
    expect(htmlForImport(html, { image })).toEqual({
      text: 'Hi,\nsee KB 1 <https://kb.example/1> and this. [image: shot.png]\n\n> On Monday Bob wrote:\n>\n> > It is down.',
      truncatedInput: false,
      truncatedOutput: false,
    });
    expect(image).toHaveBeenCalledTimes(2);
  });

  it('drops images without a resolver', () => {
    expect(htmlForImport('<p>a<img src="cid:x">b</p>').text).toBe('ab');
  });

  it('clamps at 200,000 with the marker and reports it', () => {
    const r = htmlForImport(`<p>${'x'.repeat(IMPORT_TEXT_MAX_CHARS + 10)}</p>`);
    expect(r.truncatedOutput).toBe(true);
    expect(r.truncatedInput).toBe(false);
    expect(r.text).toHaveLength(IMPORT_TEXT_MAX_CHARS);
    expect(r.text.endsWith(`x\n\n${IMPORT_TRUNCATION_MARKER}`)).toBe(true);
    expect(accepted(r.text)).toBe(true);
  });

  it('marks a body whose HTML passed the input cap', () => {
    const r = htmlForImport(`<p>${'word '.repeat(220_000)}</p><p>LOST</p>`);
    expect(r.truncatedInput).toBe(true);
    expect(r.text.endsWith(IMPORT_TRUNCATION_MARKER)).toBe(true);
    expect(r.text).not.toContain('LOST');
    expect(accepted(r.text)).toBe(true);
  });

  it('always produces text importedTicket accepts, whatever the sender put in', () => {
    const hostile = [
      '<p>a&#0;b&#1;c&#2;d&#3;e&#4;f&#7;g&#11;h&#12;i&#27;j&#31;k</p>',
      '<p>raw \u0000\u0001\u0002\u0003\u0004\u0008\u000b\u000c\u000e\u001f controls</p>',
      '<blockquote>&#3;<blockquote>&#4;</blockquote></blockquote>',
      '<a href="https://example.com/&#1;&#3;x">l&#5;</a>',
      `<p>${'\u{1F600}'.repeat(150_000)}</p>`,
    ];
    const image = () => '[image: \u0007bell\u0000.png]';
    for (const html of hostile) {
      const { text } = htmlForImport(html, { image });
      expect(accepted(text), JSON.stringify(html.slice(0, 60))).toBe(true);
    }
    expect(htmlForImport('<img src="cid:x">', { image }).text).toBe('[image: bell.png]');
  });
});

describe('the helpers are pure', () => {
  // The importer's side-effect scans cover the services that write; these
  // two convert strings and may import nothing that can.
  const imports = (file: string) => [...readFileSync(join(__dirname, file), 'utf8').matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)]
    .map((m) => m[1]);

  it('importText.ts imports only the converter and the refused-character leaf; the converter only sanitize-html', () => {
    expect(imports('importText.ts')).toEqual(['../inboundEmail/htmlToText', './refusedControlChars']);
    expect(imports('refusedControlChars.ts')).toEqual([]);
    expect(imports('../inboundEmail/htmlToText.ts')).toEqual(['sanitize-html']);
  });
});
