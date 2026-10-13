// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MessageMarkdown, MESSAGE_BODY_MAX, MESSAGE_TITLE_MAX } from './messageMarkdown';

// Anti-phishing renderer for endpoint messages (#8293, Review Focus 6). The
// body is technician-authored text shown under the IT provider's name, so a
// link must never hide where it goes.

const html = (body: string) => render(<MessageMarkdown body={body} />).container;

describe('MessageMarkdown links', () => {
  it('shows the real host when the label looks like a different URL', () => {
    const c = html('[https://bank.example](https://evil.example)');
    const a = c.querySelector('a');
    expect(a).not.toBeNull();
    expect(a).toHaveAttribute('href', 'https://evil.example/');
    expect(c.textContent).toContain('evil.example');
    expect(c.textContent).not.toContain('bank.example');
  });

  it('shows the real host when the label is a bare host that differs', () => {
    const c = html('[www.bank.example](https://evil.example/login)');
    expect(c.textContent).not.toContain('bank.example');
    expect(c.textContent).toContain('evil.example');
  });

  it('always shows the host next to a descriptive label', () => {
    const c = html('[Open the portal](https://portal.example.com/x?y=1)');
    const a = c.querySelector('a')!;
    expect(a).toHaveTextContent('Open the portal');
    expect(c.textContent).toContain('portal.example.com');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
  });

  it('replaces a label that embeds a URL anywhere with the real host only', () => {
    const c = html('[Sign in at https://login.contoso.com](https://evil.example/x)');
    expect(c.textContent).toContain('evil.example');
    expect(c.textContent).not.toContain('contoso');
    expect(c.textContent).not.toContain('Sign in');
  });

  it('replaces a label that embeds a bare host anywhere with the real host only', () => {
    const c = html('[visit login.contoso.com now](https://evil.example/x)');
    expect(c.textContent).toContain('evil.example');
    expect(c.textContent).not.toContain('contoso');
  });

  it('keeps a plain-word label and appends the real host', () => {
    const c = html('[status page](https://status.example.com/)');
    expect(c.querySelector('a')).toHaveTextContent('status page');
    expect(c.textContent).toContain('(status.example.com)');
  });

  it('does not treat "e.g." or version numbers as hosts', () => {
    const c = html('[see notes, e.g. v1.2.3](https://notes.example.com/)');
    expect(c.querySelector('a')).toHaveTextContent('see notes, e.g. v1.2.3');
  });

  it('does not duplicate the host when the label is already the same host', () => {
    const c = html('[https://portal.example.com](https://portal.example.com)');
    expect(c.textContent!.match(/portal\.example\.com/g)).toHaveLength(1);
  });

  it('renders javascript: links as text, never as an anchor', () => {
    const c = html('[x](javascript:alert(1))');
    expect(c.querySelector('a')).toBeNull();
    expect(c.textContent).toContain('x');
  });

  it('renders http: links as text', () => {
    const c = html('[x](http://a.b)');
    expect(c.querySelector('a')).toBeNull();
    expect(c.textContent).toContain('x');
  });

  it('renders data: links as text', () => {
    const c = html('[x](data:text/html;base64,PGgxPg==)');
    expect(c.querySelector('a')).toBeNull();
  });

  it('renders https links with embedded credentials as text', () => {
    const c = html('[x](https://bank.example@evil.example/)');
    expect(c.querySelector('a')).toBeNull();
  });

  it('does not auto-link a bare URL', () => {
    const c = html('go to https://evil.example now');
    expect(c.querySelector('a')).toBeNull();
    expect(c.textContent).toContain('https://evil.example');
  });
});

describe('MessageMarkdown images and HTML', () => {
  it('renders markdown images as inert text', () => {
    const c = html('![i](https://a.b/i.png)');
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector('a')).toBeNull();
    expect(c.textContent).toContain('https://a.b/i.png');
  });

  it('renders raw HTML as inert text', () => {
    const c = html('<img src=x onerror=alert(1)> and <script>alert(1)</script>');
    expect(c.querySelector('img')).toBeNull();
    expect(c.querySelector('script')).toBeNull();
    expect(c.textContent).toContain('<img');
  });
});

describe('MessageMarkdown formatting and limits', () => {
  it('renders bold, italic and lists', () => {
    const c = html('**bold** and *it*\n\n- one\n- two');
    expect(c.querySelector('strong')).toHaveTextContent('bold');
    expect(c.querySelector('em')).toHaveTextContent('it');
    expect(c.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders a 5 000-char body as plain text, with no markdown or links', () => {
    const body = '**x** [a](https://a.example) ' + 'y'.repeat(5000);
    const c = html(body);
    expect(c.querySelector('strong')).toBeNull();
    expect(c.querySelector('a')).toBeNull();
    expect(c.textContent).toContain('**x**');
  });

  it('renders as plain text when the host marks the content invalid', () => {
    const c = render(<MessageMarkdown body="**x** [a](https://a.example)" plain />).container;
    expect(c.querySelector('strong')).toBeNull();
    expect(c.querySelector('a')).toBeNull();
  });

  it('mirrors the shared content limits (120 / 2000)', () => {
    expect(MESSAGE_TITLE_MAX).toBe(120);
    expect(MESSAGE_BODY_MAX).toBe(2000);
  });
});
