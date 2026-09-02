import { describe, expect, it } from 'vitest';
import {
  isHtmlContentType,
  prefixDevAssetUrlsFor,
  shouldPrefixDevAssetUrlsFor
} from './devAssetBase';

/**
 * Regression cover for #3906: the portal dev server emits its module URLs from
 * the server root, so behind the worktree stack's path-routed Caddy every island
 * entry point 404'd against the web app and no island ever hydrated. These are
 * the exact attribute shapes `astro dev` renders (captured from a live
 * `/portal/login` response).
 */
describe('prefixDevAssetUrlsFor', () => {
  it('prefixes the astro-island entry points that hydrate a client:load component', () => {
    const html =
      '<astro-island uid="r1" component-url="/src/components/portal/PublicQuoteView.tsx"' +
      ' renderer-url="/@fs/repo/node_modules/@astrojs/react/dist/client.js"' +
      ' before-hydration-url="/@id/astro:scripts/before-hydration.js" ssr></astro-island>';

    expect(prefixDevAssetUrlsFor('/portal', html)).toBe(
      '<astro-island uid="r1" component-url="/portal/src/components/portal/PublicQuoteView.tsx"' +
        ' renderer-url="/portal/@fs/repo/node_modules/@astrojs/react/dist/client.js"' +
        ' before-hydration-url="/portal/@id/astro:scripts/before-hydration.js" ssr></astro-island>'
    );
  });

  it('prefixes the dev client, stylesheet and pre-bundled dep script tags', () => {
    const html =
      '<script type="module" src="/@vite/client"></script>' +
      '<script type="module" src="/src/styles/globals.css"></script>' +
      '<script type="module" src="/@react-refresh"></script>' +
      '<script type="module" src="/node_modules/.vite/deps/react.js?v=725ea0a5"></script>';

    expect(prefixDevAssetUrlsFor('/portal', html)).toBe(
      '<script type="module" src="/portal/@vite/client"></script>' +
        '<script type="module" src="/portal/src/styles/globals.css"></script>' +
        '<script type="module" src="/portal/@react-refresh"></script>' +
        '<script type="module" src="/portal/node_modules/.vite/deps/react.js?v=725ea0a5"></script>'
    );
  });

  it('leaves portal routes, API calls and public assets alone', () => {
    const html =
      '<a href="/portal/quotes">Quotes</a>' +
      '<form action="/api/v1/portal/auth/login">' +
      '<link rel="icon" href="/portal/favicon.svg">' +
      '<a href="/srcset-guide">not a dev namespace</a>';

    expect(prefixDevAssetUrlsFor('/portal', html)).toBe(html);
  });

  it('is idempotent — a second pass does not double-prefix', () => {
    const html = '<astro-island component-url="/src/components/portal/LoginForm.tsx"></astro-island>';
    const once = prefixDevAssetUrlsFor('/portal', html);

    expect(prefixDevAssetUrlsFor('/portal', once)).toBe(once);
    expect(once).toContain('component-url="/portal/src/components/portal/LoginForm.tsx"');
  });

  it('handles single-quoted attributes and a non-default base', () => {
    const html = "<script type='module' src='/@vite/client'></script>";

    expect(prefixDevAssetUrlsFor('/customer', html)).toBe(
      "<script type='module' src='/customer/@vite/client'></script>"
    );
  });

  it('is a pass-through at a root deploy (empty base)', () => {
    const html = '<astro-island component-url="/src/components/portal/LoginForm.tsx"></astro-island>';

    expect(prefixDevAssetUrlsFor('', html)).toBe(html);
  });

  it('rewrites every occurrence, not just the first', () => {
    const html = '<script src="/@vite/client"></script><script src="/src/a.ts"></script><script src="/src/b.ts"></script>';

    expect(prefixDevAssetUrlsFor('/portal', html)).toBe(
      '<script src="/portal/@vite/client"></script><script src="/portal/src/a.ts"></script><script src="/portal/src/b.ts"></script>'
    );
  });
});

describe('shouldPrefixDevAssetUrlsFor', () => {
  const html = { isDev: true, hasBody: true, contentType: 'text/html; charset=utf-8' };

  it('rewrites a dev HTML page response', () => {
    expect(shouldPrefixDevAssetUrlsFor('/portal', html)).toBe(true);
  });

  it('never rewrites in a production build', () => {
    expect(shouldPrefixDevAssetUrlsFor('/portal', { ...html, isDev: false })).toBe(false);
  });

  it('never rewrites at a root deploy (empty base)', () => {
    expect(shouldPrefixDevAssetUrlsFor('', html)).toBe(false);
  });

  it('skips a null-body status — swapping its body for a string throws in Response', () => {
    // A 304 can still carry Content-Type: text/html. Rewriting it would hand
    // `new Response('', { status: 304 })` a body, which the constructor rejects.
    expect(shouldPrefixDevAssetUrlsFor('/portal', { ...html, hasBody: false })).toBe(false);
    expect(() => new Response('', { status: 304 })).toThrow();
  });

  it('skips non-HTML bodies (JSON endpoints, assets)', () => {
    expect(
      shouldPrefixDevAssetUrlsFor('/portal', { ...html, contentType: 'application/json' })
    ).toBe(false);
    expect(shouldPrefixDevAssetUrlsFor('/portal', { ...html, contentType: null })).toBe(false);
  });
});

describe('isHtmlContentType', () => {
  it.each([
    ['text/html; charset=utf-8', true],
    ['text/html', true],
    ['TEXT/HTML;charset=UTF-8', true],
    ['application/json', false],
    ['text/html-ish', false],
    [null, false]
  ])('%s → %s', (contentType, expected) => {
    expect(isHtmlContentType(contentType)).toBe(expected);
  });
});
