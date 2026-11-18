import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OAUTH_ERROR_PAGE_PATH, OAUTH_ERROR_PAGE_REASONS } from '@breeze/shared';
import { oauthErrorCopy, resolveOauthErrorView } from './oauthErrorPage';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function lookup(bundle: unknown, key: string): unknown {
  let node = bundle;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

describe('resolveOauthErrorView (#9938)', () => {
  it.each(OAUTH_ERROR_PAGE_REASONS)('keeps the known reason %s', (reason) => {
    expect(resolveOauthErrorView(reason)).toBe(reason);
  });

  it.each([null, '', 'access_denied', 'INVALID_CLIENT', '<script>alert(1)</script>', 'invalid_client '])(
    'falls back to the generic copy for %j',
    (raw) => {
      expect(resolveOauthErrorView(raw)).toBe('generic');
    },
  );
});

describe('oauthErrorCopy', () => {
  const views = [...OAUTH_ERROR_PAGE_REASONS, 'generic'] as const;

  it('gives every view its own heading and body', () => {
    const headings = new Set(views.map((v) => oauthErrorCopy(v).headingKey));
    const bodies = new Set(views.map((v) => oauthErrorCopy(v).bodyKey));
    expect(headings.size).toBe(views.length);
    expect(bodies.size).toBe(views.length);
  });

  it('every key resolves to a string in every locale', () => {
    const localesDir = join(srcDir, 'locales');
    const problems: string[] = [];
    const locales = readdirSync(localesDir).filter((entry) => statSync(join(localesDir, entry)).isDirectory());
    expect(locales).toHaveLength(8);
    for (const locale of locales) {
      const bundle = JSON.parse(readFileSync(join(localesDir, locale, 'pages.json'), 'utf8'));
      for (const view of views) {
        const { headingKey, bodyKey } = oauthErrorCopy(view);
        for (const key of [headingKey, bodyKey, 'oauthErrorPage.nextStep', 'titles.oauthError']) {
          const value = lookup(bundle, key);
          if (typeof value !== 'string' || value.trim() === '') problems.push(`${locale}: ${key}`);
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

describe('the /oauth/consent/error page', () => {
  const src = readFileSync(join(srcDir, 'pages/oauth/consent/error.astro'), 'utf8');

  it('is served at the path the API redirects to', () => {
    // /oauth/consent/* is the one /oauth subtree every documented proxy
    // (Caddyfile.prod, guided-setup nginx, Cloudflare tunnel) sends to web.
    expect(OAUTH_ERROR_PAGE_PATH).toBe('/oauth/consent/error');
  });

  it('renders in the auth layout the consent screen uses', () => {
    expect(src).toMatch(/import AuthLayout from '..\/..\/..\/layouts\/AuthLayout.astro'/);
    expect(src).toMatch(/<AuthLayout titleKey="titles\.oauthError">/);
  });

  it('answers with an error status, not 200', () => {
    expect(src).toMatch(/Astro\.response\.status = 400;/);
  });

  it('reads only the reason param and never renders raw HTML', () => {
    const params = [...src.matchAll(/searchParams\.get\('([^']+)'\)/g)].map((m) => m[1]);
    expect(params).toEqual(['reason']);
    expect(src).not.toMatch(/set:html/);
  });
});
