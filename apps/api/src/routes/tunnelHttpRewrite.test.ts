import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { rewriteTunnelCss, rewriteTunnelHtml, rewriteTunnelUrl } from './tunnelHttpRewrite';

const options = { basePath: '/api/v1/tunnel-http/test/', targetOrigin: 'http://printer.example:80' };
const base = options.basePath;

describe('rewriteTunnelUrl', () => {
  it.each([
    ['/a/../../x', `${base}x`],
    [`${base}../../devices`, `${base}api/v1/devices`],
    [`${base}%2e%2e/%2e%2e/devices`, `${base}api/v1/devices`],
    [`${base}assets/../app.js?x=1#part`, `${base}app.js?x=1#part`],
    ['/webglue/app.js?x=1#part', `${base}webglue/app.js?x=1#part`],
    ['http://printer.example/x', `${base}x`],
    ['http://PRINTER.example:80/x', `${base}x`],
    ['https://printer.example:80/x', `${base}x`],
    ['//printer.example/x', `${base}x`],
    [`${base}x`, `${base}x`],
    ['http://other.example/x', 'http://other.example/x'],
    ['//other.example/x', '//other.example/x'],
    ['http://printer.example:8080/x', 'http://printer.example:8080/x'],
    ['https://printer.example/x', 'https://printer.example/x'],
    ['http://printer.example.evil/x', 'http://printer.example.evil/x'],
    ['http://printer.example@other.example/x', 'http://printer.example@other.example/x'],
    ['relative/x', 'relative/x'],
    ['../x', '../x'],
    ['#anchor', '#anchor'],
    ['?page=2', '?page=2'],
    ['data:image/png;base64,abc', 'data:image/png;base64,abc'],
    ['javascript:void(0)', 'javascript:void(0)'],
    ['mailto:user@example.com', 'mailto:user@example.com'],
    ['http://[invalid', 'http://[invalid'],
    ['', ''],
  ])('maps %s', (input, expected) => {
    expect(rewriteTunnelUrl(input, options)).toBe(expected);
  });

  it('handles HTTPS and IPv6 targets with explicit ports', () => {
    expect(rewriteTunnelUrl('//[2001:db8::1]:8443/x', {
      ...options, targetOrigin: 'https://[2001:db8::1]:8443',
    })).toBe(`${base}x`);
    expect(rewriteTunnelUrl('https://printer.example:443/x', {
      ...options, targetOrigin: 'https://printer.example',
    })).toBe(`${base}x`);
  });
});

describe('rewriteTunnelCss', () => {
  it.each([
    ['url(/img.png)', `url(${base}img.png)`],
    ['url( "/img.png" )', `url( "${base}img.png" )`],
    ["URL('/img.png')", `URL('${base}img.png')`],
    ['url(http://printer.example/x)', `url(${base}x)`],
    ['@import "/theme.css" screen;', `@import "${base}theme.css" screen;`],
    ["@import '/theme.css';", `@import '${base}theme.css';`],
    ['@import url(/theme.css);', `@import url(${base}theme.css);`],
    ['url(../relative.png)', 'url(../relative.png)'],
    ['url(data:image/png;base64,abc)', 'url(data:image/png;base64,abc)'],
    ['url(https://other.example/x)', 'url(https://other.example/x)'],
    ['/* url(/comment) */ a::before{content:"url(/text)"}', '/* url(/comment) */ a::before{content:"url(/text)"}'],
  ])('rewrites CSS %s', (input, expected) => {
    expect(rewriteTunnelCss(input, options)).toBe(expected);
  });
});

describe('rewriteTunnelHtml', () => {
  it.each([
    ['<script src="/app.js"></script>', `<script src="${base}app.js"></script>`],
    ["<link href='/style.css'>", `<link href='${base}style.css'>`],
    ['<form action=/login>', `<form action=${base}login>`],
    ['<IMG SRC = "/image.png" alt=">">', `<IMG SRC = "${base}image.png" alt=">">`],
    ['<a href="http://printer.example/page?a=1&amp;b=2">', `<a href="${base}page?a=1&amp;b=2">`],
    ['<img src="//printer.example/img">', `<img src="${base}img">`],
    ['<a href="https://other.example/x">', '<a href="https://other.example/x">'],
    ['<img srcset="/a 1x, http://printer.example/b 2x, relative 3x">', `<img srcset="${base}a 1x, ${base}b 2x, relative 3x">`],
    ['<img srcset="data:image/jpeg;base64,/9j/4AAQ 1x, /b 2x">', `<img srcset="data:image/jpeg;base64,/9j/4AAQ 1x, ${base}b 2x">`],
    ['<img srcset="/a,/b 2x">', `<img srcset="${base}a,${base}b 2x">`],
    ['<source srcset="data:image/png;base64,abc 1x, /b 2x">', `<source srcset="data:image/png;base64,abc 1x, ${base}b 2x">`],
    ['<img style="background:url(\'/x\')">', `<img style="background:url('${base}x')">`],
    ['<style>@import "/x";a{background:url(/y)}</style>', `<style>@import "${base}x";a{background:url(${base}y)}</style>`],
    ['<div data-src="/x" title="src=\'/y\'">', '<div data-src="/x" title="src=\'/y\'">'],
    ['<!-- <img src="/x"> -->', '<!-- <img src="/x"> -->'],
    ['<script>const s = \'<img src="/x">\';</script>', '<script>const s = \'<img src="/x">\';</script>'],
    ['<img style="background:url(&quot;/x.png&quot;)">', `<img style="background:url(&quot;${base}x.png&quot;)">`],
    ['<img src="&#47;x.png">', `<img src="${base}x.png">`],
    ['<textarea><img src="/x"></textarea>', '<textarea><img src="/x"></textarea>'],
  ])('rewrites HTML %s', (input, expected) => {
    expect(rewriteTunnelHtml(input, options)).toContain(expected);
  });

  it.each([
    '<html><head><script src="/app.js"></script></head></html>',
    '<!doctype html><html><body>x</body></html>',
    '<script src="/app.js"></script>',
    '<html><head><base href="http://printer.example/"><base href="/other"></head></html>',
    '',
  ])('injects base and shim once, before device scripts, including on repeated rewriting', (input) => {
    const result = rewriteTunnelHtml(input, options);
    expect(result.match(/<base\b/g)).toHaveLength(1);
    expect(result.match(/<script data-breeze-tunnel-rewrite>/g)).toHaveLength(1);
    expect(result).toContain(`<base href="${base}">`);
    if (input.includes('/app.js')) {
      expect(result.indexOf('data-breeze-tunnel-rewrite')).toBeLessThan(result.indexOf(`src="${base}app.js"`));
    }
    expect(rewriteTunnelHtml(result, options)).toBe(result);
  });

  it('puts the shim and base before fragment content, preserving a leading doctype', () => {
    const result = rewriteTunnelHtml('<!doctype html><img src="relative.png"><script>load()</script>', options);
    expect(result.startsWith(`<!doctype html><base href="${base}">`)).toBe(true);
    expect(result.indexOf('data-breeze-tunnel-rewrite')).toBeLessThan(result.indexOf('<img'));
  });

  it('executes the injected shim with native argument/return behavior preserved', async () => {
    const fetch = vi.fn().mockResolvedValue('response');
    const open = vi.fn();
    const setAttribute = vi.fn();
    const pushState = vi.fn();
    const replaceState = vi.fn();
    const WebSocket = vi.fn();
    const context = {
      location: { href: 'https://breeze.example/api/v1/tunnel-http/test/' },
      URL, Request, fetch, XMLHttpRequest: function () {}, Element: function () {},
      history: { pushState, replaceState }, WebSocket,
    };
    context.XMLHttpRequest.prototype.open = open;
    context.Element.prototype.setAttribute = setAttribute;
    const html = rewriteTunnelHtml('<head></head>', options);
    const script = html.match(/<script data-breeze-tunnel-rewrite>([\s\S]*?)<\/script>/)![1]!;
    runInNewContext(script, context);
    expect(await context.fetch('/api/status', { method: 'POST' })).toBe('response');
    expect(fetch).toHaveBeenLastCalledWith(`${base}api/status`, { method: 'POST' });
    await context.fetch(new URL('http://printer.example/url'));
    expect(fetch).toHaveBeenLastCalledWith(`${base}url`, undefined);
    await context.fetch('https://other.example/x');
    expect(fetch).toHaveBeenLastCalledWith('https://other.example/x', undefined);
    const request = new Request('http://printer.example/api', { method: 'POST', body: 'payload' });
    // Request constructor needs an absolute browser URL; supply the browser's resolution here.
    const BrowserRequest = class extends Request {
      constructor(input: string | Request, init?: RequestInit) {
        super(typeof input === 'string' ? new URL(input, 'https://breeze.example') : input, init);
      }
    };
    Object.assign(context, { Request: BrowserRequest });
    const browserRequest = new BrowserRequest(request);
    await context.fetch(browserRequest);
    const forwarded = fetch.mock.calls.at(-1)![0] as Request;
    expect(forwarded.url).toBe(`https://breeze.example${base}api`);
    expect(forwarded.method).toBe('POST');
    expect(await forwarded.text()).toBe('payload');
    await context.fetch(new BrowserRequest('/request-path'));
    expect((fetch.mock.calls.at(-1)![0] as Request).url).toBe(`https://breeze.example${base}request-path`);
    context.XMLHttpRequest.prototype.open.call({}, 'POST', '/xhr', false, 'user', 'password');
    expect(open).toHaveBeenCalledWith('POST', `${base}xhr`, false, 'user', 'password');
    context.Element.prototype.setAttribute.call({}, 'SRC', '/dynamic');
    expect(setAttribute).toHaveBeenLastCalledWith('SRC', `${base}dynamic`);
    context.Element.prototype.setAttribute.call({}, 'data-src', '/untouched');
    expect(setAttribute).toHaveBeenLastCalledWith('data-src', '/untouched');
    context.history.pushState({}, '', '/page');
    expect(pushState).toHaveBeenCalledWith({}, '', `${base}page`);
    context.history.replaceState({}, '', 'http://printer.example/next');
    expect(replaceState).toHaveBeenCalledWith({}, '', `${base}next`);
    expect(context.WebSocket).toBe(WebSocket);
  });
});
