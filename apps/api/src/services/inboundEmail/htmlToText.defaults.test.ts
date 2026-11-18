/**
 * #8313 W3 (spec 2026-10-19 §5.4): htmlToText gained options, and with none
 * its output must not move by a byte for its three callers — the Graph and
 * Gmail normalizers and the partner email renderer. The oracle is a frozen
 * copy of the converter as it was before the options (main 2e7295b79); the
 * corpus is the HTML its callers' tests feed it, the renderer's real inputs
 * for every template, and a few shapes the import options care about.
 */
import { EMAIL_TEMPLATE_IDS, EMAIL_TEMPLATE_VARIANTS, type EmailTemplateId } from '@breeze/shared';
import type { gmail_v1 } from '@googleapis/gmail';
import sanitizeHtml from 'sanitize-html';
import { describe, expect, it, vi } from 'vitest';
import { renderPartnerEmail } from '../emailTemplates/renderPartnerEmail';
import { normalizeGmailMessage } from '../ticketMailbox/normalizeGmailMessage';
import { normalizeGraphMessage } from '../ticketMailbox/normalizeGraphMessage';
import type { GraphMessage } from '../ticketMailbox/graphMailClient';
import type { HtmlToTextOptions } from './htmlToText';

// The renderer's htmlToText input is internal (the body with the button as
// text), so the module is wrapped to record what it is handed.
const rendererInputs = vi.hoisted(() => [] as string[]);
vi.mock('./htmlToText', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./htmlToText')>();
  return {
    ...actual,
    htmlToText: (html: string, opts?: HtmlToTextOptions) => {
      rendererInputs.push(html);
      return actual.htmlToText(html, opts);
    },
  };
});
const { htmlToText, htmlToTextDetailed } = await vi.importActual<typeof import('./htmlToText')>('./htmlToText');

// ---- Frozen copy of apps/api/src/services/inboundEmail/htmlToText.ts at
// ---- 2e7295b79. Do not edit: it is the reference the defaults are held to.
const LEGACY_MAX_TEXT = 50_000;
const LEGACY_MAX_INPUT = 1_000_000;
const LEGACY_BREAK_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'table', 'pre', 'hr',
  'br', 'div', 'li', 'tr', 'td', 'th',
];
const LEGACY_NON_TEXT_TAGS = ['style', 'script', 'textarea', 'option', 'noscript', 'head', 'title'];
const LEGACY_PARAGRAPH_TAG_RE = /<\/?(?:p|h[1-6]|blockquote|ul|ol|table|pre)>|<hr ?\/?>/g;
const LEGACY_LINE_TAG_RE = /<br ?\/?>|<\/?(?:div|li|tr)>/g;
const LEGACY_CELL_TAG_RE = /<\/?t[dh]>/g;
const LEGACY_PARA = '\u0002';
const LEGACY_LINE = '\u0001';
const LEGACY_BREAK_RUN_RE = /[ \u0001\u0002]*[\u0001\u0002][ \u0001\u0002]*/g;
function legacyHtmlToText(html: string): string {
  const sanitized = sanitizeHtml(html.slice(0, LEGACY_MAX_INPUT), {
    allowedTags: LEGACY_BREAK_TAGS,
    allowedAttributes: {},
    nonTextTags: LEGACY_NON_TEXT_TAGS,
  });
  const text = sanitized
    .replace(/[\u0001\u0002]/g, '')
    .replace(/\s+/g, ' ')
    .replace(LEGACY_PARAGRAPH_TAG_RE, LEGACY_PARA)
    .replace(LEGACY_LINE_TAG_RE, LEGACY_LINE)
    .replace(LEGACY_CELL_TAG_RE, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\u00a0/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(LEGACY_BREAK_RUN_RE, (run) => (run.includes(LEGACY_PARA) ? '\n\n' : '\n'))
    .trim()
    .slice(0, LEGACY_MAX_TEXT);
  return text.replace(/[\uD800-\uDBFF]$/, '');
}
// ---- end of frozen copy.

const EXPLICIT_DEFAULTS: HtmlToTextOptions = {
  maxOutputChars: 50_000,
  links: 'drop',
  quotes: 'flatten',
  image: undefined,
  truncationMarker: undefined,
  stripControlChars: false,
};

const longPara = 'The printer on the second floor has been jamming since Monday morning. '.repeat(6).trim();

/** HTML bodies from normalizeGraphMessage.test.ts and normalizeGmailMessage.test.ts. */
const NORMALIZER_FIXTURES = {
  'graph: full body with head, entities and lists': `<html><head><title>ignored title</title><style>p { color: red; }</style></head><body>`
    + `<p>Hi   team,</p>\n<p>${longPara}</p><div>Line one<br>Line two<br/>Line&nbsp;three</div>`
    + `<ul><li>first &amp; foremost</li><li>a &lt;b&gt; tag</li></ul><p>Thanks</p></body></html>`,
  'graph: Gmail div-per-line': '<div dir="ltr"><div>Hello</div><div>The VPN is down.</div><div><br></div><div>Bob</div></div>',
  'graph: Outlook MsoNormal': '<div class="WordSection1"><p class="MsoNormal">Hi,<o:p></o:p></p>'
    + '<p class="MsoNormal"><o:p>&nbsp;</o:p></p><p class="MsoNormal">Outlook crashes.<o:p></o:p></p></div>',
  'graph: table cells': '<table><tr><td>Server</td><td>PROD01</td></tr><tr><th>Age</th><td>30</td></tr></table>',
  'graph: script dropped': '<p>before</p><script>alert("x")</script><p>after</p>',
  'graph: entity-encoded markers': '<p>Hello&#x2;World&#1;!</p><p>after</p>',
  'graph: unclosed tag soup': '<p '.repeat(80_000),
  'graph: tag soup in an attribute': `<div class="x ${'<p '.repeat(80_000)}`,
  'graph: strips to empty': '<p> </p><img src="x.png">',
  'graph: real text': '<p>full body</p>',
  'graph: 60k clamp': `<p>${'x'.repeat(60_000)}</p>`,
  'gmail: please help': '<p>please help</p>',
  'gmail: html only': '<p>html only</p>',
  'gmail: 50k unmatched <': '<'.repeat(50_000),
  'gmail: 400k unmatched <': '<'.repeat(400_000),
  'gmail: lone <': '<p>Quote:</p>the price &lt; 100 and 5 < 10, call me back please',
  'gmail: > in an attribute': '<p title="1 > 0">Call me</p>',
  'gmail: style/script vs look-alike': '<style>.x{color:red}</style><p>Body one</p><script>alert(1)</script><styled-note>Body two</styled-note>done',
  'gmail: unclosed style': '<p>Important before</p><style type="text/css">and the actual message the customer typed',
  'gmail: long filler': `<p>start</p>${'<p>line</p>'.repeat(30_000)}<p>END-MARKER</p>`,
  'gmail: past the snippet': '<p>Intro line.</p><p>Details <b>after</b> the preview cutoff.</p>',
} satisfies Record<string, string>;

/** Shapes the import options handle differently; the defaults must not. */
const IMPORT_SHAPES = {
  links: '<p>See <a href="https://example.com/a?b=1&amp;c=2">the docs</a>, <a href="mailto:bob@example.com">bob@example.com</a>'
    + ' and <a href="javascript:alert(1)">this</a> or <a href="https://example.com">https://example.com</a>.</p>',
  'link with block content': '<a href="https://example.com"><p>Click</p><p>here</p></a>',
  images: '<p>Logo <img src="cid:logo@x" alt="Logo"> and <img src="https://track.example/p.gif"></p>',
  'nested quotes': '<p>Reply</p><blockquote><p>Earlier</p><blockquote><p>Earliest</p></blockquote><p>Back</p></blockquote><p>Bye</p>',
  'control characters': '<p>a&#3;b&#4;c&#7;d&#11;e&#12;f&#31;g</p>',
  'surrogate pair at the cut': `<p>${'a'.repeat(49_999)}\u{1F600}tail</p>`,
  'lone high surrogate at the end': '<p>ends with \uD83D</p>',
  'input past the 1M cap': `<p>${'y '.repeat(600_000)}</p>`,
  'nbsp and spaces': '<p>a&nbsp;&nbsp; b\u00a0\u00a0c\t\td</p>',
  'quote markers in text': '<p>x&#3;y&#4;z</p><blockquote>q</blockquote>',
} satisfies Record<string, string>;

const CORPUS = { ...NORMALIZER_FIXTURES, ...IMPORT_SHAPES };

const graphMessage = (content: string): GraphMessage => ({
  id: 'graph-defaults',
  internetMessageId: '<defaults@mail.x.com>',
  subject: 'Defaults',
  from: { emailAddress: { address: 'cust@x.com', name: 'Cust' } },
  toRecipients: [{ emailAddress: { address: 'support@a.com' } }],
  conversationId: 'conv-defaults',
  body: { contentType: 'html', content },
  hasAttachments: false,
  internetMessageHeaders: [],
});

const gmailMessage = (html: string): gmail_v1.Schema$Message => ({
  id: 'gmsg-defaults',
  threadId: 't',
  internalDate: '1758300000000',
  labelIds: ['INBOX'],
  payload: {
    mimeType: 'text/html',
    headers: [{ name: 'From', value: 'cust@x.com' }],
    body: { data: Buffer.from(html, 'utf8').toString('base64url') },
  },
});

describe('htmlToText defaults are byte-identical to the pre-#8313 converter', () => {
  it.each(Object.entries(CORPUS))('%s', (_name, html) => {
    const expected = legacyHtmlToText(html);
    expect(htmlToText(html)).toBe(expected);
    expect(htmlToText(html, {})).toBe(expected);
    expect(htmlToText(html, EXPLICIT_DEFAULTS)).toBe(expected);
    expect(htmlToTextDetailed(html, EXPLICIT_DEFAULTS).text).toBe(expected);
  });

  it('the corpus exercises the clamps and the new shapes (self-check)', () => {
    expect(legacyHtmlToText(CORPUS['graph: 60k clamp'])).toHaveLength(50_000);
    expect(legacyHtmlToText(CORPUS['surrogate pair at the cut'])).toHaveLength(49_999);
    expect(CORPUS['input past the 1M cap'].length).toBeGreaterThan(1_000_000);
    expect(legacyHtmlToText(CORPUS.links)).toContain('the docs');
    expect(legacyHtmlToText(CORPUS['control characters'])).toContain('\u0003');
  });

  it.each(Object.entries(NORMALIZER_FIXTURES))('the Graph and Gmail normalizers still derive %s the same way', (_name, html) => {
    const expected = legacyHtmlToText(html);
    expect(normalizeGraphMessage(graphMessage(html), 'p', 'support@a.com').text).toBe(expected);
    expect(normalizeGmailMessage(gmailMessage(html), 'p', 'support@a.com', 'sub').text).toBe(expected);
  });

  it('the partner email renderer derives every template body the same way', () => {
    const renders: Array<{ id: EmailTemplateId; variant?: string }> = EMAIL_TEMPLATE_IDS.flatMap((id) => [
      { id },
      ...((EMAIL_TEMPLATE_VARIANTS as Partial<Record<EmailTemplateId, readonly string[]>>)[id] ?? []).map((variant) => ({ id, variant })),
    ]);
    const customBodies = [
      null,
      '<p>Hi {{requester_name}}</p><blockquote>quoted <a href="https://example.com/x">link</a></blockquote>{{cta_button}}<p>Bye</p>',
      '<script>alert(1)</script><p>Hello <img src="https://example.com/i.png" alt="i"> there</p>',
    ];
    let compared = 0;
    for (const { id, variant } of renders) {
      for (const html of customBodies) {
        rendererInputs.length = 0;
        const out = renderPartnerEmail({
          id,
          variant,
          vars: { requester_name: 'Ada <x> & Co', partner_name: 'Example MSP', client_name: 'Acme', invoice_number: 'INV-7' },
          ctaUrl: 'https://portal.example.test/t/abc?x=1&y=2',
          ticketNumber: 'T-2026-0001',
          ticketSubject: 'Printer is down',
          custom: html ? { subject: null, heading: null, buttonLabel: null, html } : null,
          bodyBeforeCta: '<p>NOTE &amp; more</p>',
        });
        expect(rendererInputs).toHaveLength(1);
        const [input] = rendererInputs;
        expect(out.bodyText).toBe(legacyHtmlToText(input!));
        expect(htmlToText(input!, EXPLICIT_DEFAULTS)).toBe(out.bodyText);
        compared += 1;
      }
    }
    expect(compared).toBe(renders.length * customBodies.length);
    expect(compared).toBeGreaterThan(EMAIL_TEMPLATE_IDS.length);
  });
});
