import { describe, it, expect } from 'vitest';
import { normalizeBase, withBaseFor, stripBaseFor, isOutsideBaseFor, withBase, stripBase, isOutsideBase, BASE_PATH } from './basePath';

describe('normalizeBase', () => {
  it.each([
    ['/portal/', '/portal'],
    ['/portal', '/portal'],
    ['/c/', '/c'],
    ['/foo/bar/', '/foo/bar'],
    ['/', ''],
    ['', ''],
    [undefined, ''],
    [null, ''],
  ])('normalizes %j → %j', (input, expected) => {
    expect(normalizeBase(input as string)).toBe(expected);
  });
});

describe('withBaseFor (base = /portal)', () => {
  const base = '/portal';

  it('prefixes an app-relative path', () => {
    expect(withBaseFor(base, '/login')).toBe('/portal/login');
  });

  it('is idempotent on an already-based path', () => {
    expect(withBaseFor(base, '/portal/login')).toBe('/portal/login');
  });

  it('treats the bare base as already-based', () => {
    expect(withBaseFor(base, '/portal')).toBe('/portal');
  });

  it('does NOT treat a path that merely shares the base prefix as based', () => {
    // boundary: "/portalish" must be prefixed, not mistaken for "/portal"
    expect(withBaseFor(base, '/portalish')).toBe('/portal/portalish');
    expect(withBaseFor(base, '/console')).toBe('/portal/console');
  });

  it('adds a leading slash to relative input', () => {
    expect(withBaseFor(base, 'login')).toBe('/portal/login');
  });

  it('returns the base root for empty input', () => {
    expect(withBaseFor(base, '')).toBe('/portal');
  });

  it('passes external URLs and anchors through untouched', () => {
    for (const ext of ['https://x.com/a', 'http://x.com', 'mailto:a@b.com', 'tel:+15551234567', '//cdn.example/x', '#section']) {
      expect(withBaseFor(base, ext)).toBe(ext);
    }
  });
});

describe('withBaseFor (base = "" / root deploy)', () => {
  it('is a no-op for app paths', () => {
    expect(withBaseFor('', '/login')).toBe('/login');
  });
  it('returns "/" for empty input', () => {
    expect(withBaseFor('', '')).toBe('/');
  });
});

describe('stripBaseFor (base = /portal)', () => {
  const base = '/portal';

  it.each([
    ['/portal/login', '/login'],
    ['/portal/tickets/123', '/tickets/123'],
    ['/portal', '/'],
    ['/portal/', '/'],
    ['/login', '/login'], // already de-based / absent → no-op
    ['/portalish', '/portalish'], // boundary: shared prefix is not the base
  ])('strips %j → %j', (input, expected) => {
    expect(stripBaseFor(base, input)).toBe(expected);
  });
});

describe('stripBaseFor (base = "" / root deploy)', () => {
  it('returns the pathname unchanged', () => {
    expect(stripBaseFor('', '/login')).toBe('/login');
    expect(stripBaseFor('', '/')).toBe('/');
  });
});

describe('isOutsideBaseFor (base = /portal)', () => {
  const base = '/portal';

  it.each([
    ['/portal', false], // the bare base is in-base
    ['/portal/', false],
    ['/portal/login', false],
    ['/portal/quotes/123', false],
    ['/portal/_astro/app.js', false],
    ['/login', true], // web owns the un-based root — portal must 404 it
    ['/', true],
    ['/quotes', true],
    ['/api/v1/portal/auth/login', true], // API is same-origin via Caddy, never the portal
    ['/portalish', true], // boundary: shared prefix is NOT the base
  ])('%j → outside=%s', (pathname, expected) => {
    expect(isOutsideBaseFor(base, pathname as string)).toBe(expected);
  });
});

describe('isOutsideBaseFor (base = "" / root deploy)', () => {
  it('is never outside the base when the portal owns the root', () => {
    for (const p of ['/', '/login', '/anything']) {
      expect(isOutsideBaseFor('', p)).toBe(false);
    }
  });
});

describe('round-trip', () => {
  it('stripBaseFor ∘ withBaseFor === identity for app paths', () => {
    const base = '/portal';
    for (const p of ['/login', '/tickets/123', '/invoices', '/profile']) {
      expect(stripBaseFor(base, withBaseFor(base, p))).toBe(p);
    }
  });
});

describe('bound exports honor the build-time BASE_PATH', () => {
  it('withBase/stripBase use BASE_PATH and are mutually consistent', () => {
    // BASE_PATH is whatever the test build injected (root "" under vitest).
    expect(withBase('/login')).toBe(withBaseFor(BASE_PATH, '/login'));
    expect(stripBase('/login')).toBe(stripBaseFor(BASE_PATH, '/login'));
    // Round-trips regardless of the configured base.
    expect(stripBase(withBase('/devices'))).toBe('/devices');
    expect(isOutsideBase('/login')).toBe(isOutsideBaseFor(BASE_PATH, '/login'));
  });
});
