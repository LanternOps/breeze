import { describe, it, expect } from 'vitest';
import { buildPortalCustomCss, escapeStyleElementContent } from './customCss';

describe('escapeStyleElementContent', () => {
  it('leaves ordinary CSS untouched', () => {
    const css = '.portal-header { letter-spacing: 0.04em; }';
    expect(escapeStyleElementContent(css)).toBe(css);
  });

  it('breaks the </style> sequence so it cannot close the element early', () => {
    const css = '</style><script>alert(1)</script>';
    const escaped = escapeStyleElementContent(css);
    expect(escaped).not.toContain('</style>');
    expect(escaped).not.toMatch(/<\/style/i);
    expect(escaped).toBe('<\\/style><script>alert(1)</script>');
  });

  it('is case-insensitive', () => {
    expect(escapeStyleElementContent('</STYLE>')).not.toMatch(/<\/style/i);
  });

  it.each(['</StYle>', '</Style >', '</style\n>', '</style foo="bar">'])(
    'breaks %j regardless of trailing whitespace/attributes/case, matching how the HTML tokenizer ends a raw-text element',
    (v) => {
      expect(escapeStyleElementContent(v)).not.toMatch(/<\/style/i);
    }
  );

  it('breaks every occurrence, not just the first', () => {
    const css = '</style>a</style>b</style>';
    const escaped = escapeStyleElementContent(css);
    expect(escaped).not.toMatch(/<\/style/i);
    expect(escaped.match(/<\\\/style/gi)).toHaveLength(3);
  });

  it('leaves legitimate angle brackets that are not part of </style untouched', () => {
    const css = '.a[data-x="<"]::before { content: "<div>"; }';
    expect(escapeStyleElementContent(css)).toBe(css);
  });
});

describe('buildPortalCustomCss', () => {
  it('renders the saved CSS verbatim when present', () => {
    const css = '.portal-header { letter-spacing: 0.04em; }\n.doc-accent-bg { opacity: 0.5; }';
    expect(buildPortalCustomCss(css)).toBe(css);
  });

  it('trims surrounding whitespace', () => {
    expect(buildPortalCustomCss('  .a { color: red; }  ')).toBe('.a { color: red; }');
  });

  it.each([null, undefined, '', '   '])('emits nothing for %j so no <style> element renders', (v) => {
    expect(buildPortalCustomCss(v as string | null | undefined)).toBeNull();
  });

  it('escapes a </style> breakout attempt in the saved CSS', () => {
    const result = buildPortalCustomCss('.a{color:red}</style><img src=x onerror=alert(1)>');
    expect(result).not.toBeNull();
    expect(result).not.toMatch(/<\/style/i);
  });
});
