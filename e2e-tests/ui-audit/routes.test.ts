import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  enumerateRoutes,
  fileToPattern,
  patternToRegex,
  resolveDynamicRoutes,
  routeSlug,
} from './routes';

function tree(files: string[]): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ui-audit-routes-'));
  for (const f of files) {
    const abs = path.join(root, f);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, '---\n---\n');
  }
  return root;
}

describe('fileToPattern', () => {
  it('maps index files to their directory and keeps dynamic segments', () => {
    expect(fileToPattern('index.astro', '')).toBe('/');
    expect(fileToPattern('devices/index.astro', '')).toBe('/devices');
    expect(fileToPattern('devices/[id].astro', '')).toBe('/devices/[id]');
    expect(fileToPattern('scripts/[id]/executions.astro', '')).toBe('/scripts/[id]/executions');
  });

  it('applies the app prefix, including to the root index', () => {
    expect(fileToPattern('index.astro', '/portal')).toBe('/portal');
    expect(fileToPattern('tickets/[id].astro', '/portal')).toBe('/portal/tickets/[id]');
  });
});

describe('enumerateRoutes', () => {
  it('lists only .astro pages, skipping test dirs, underscore dirs and endpoints', () => {
    const root = tree([
      'index.astro',
      'devices/index.astro',
      'devices/[id].astro',
      'devices/__tests__/page.test.ts',
      'devices/__tests__/fixture.astro',
      '_partials/card.astro',
      'api/sentry-smoke.ts',
      'tickets/index.test.ts',
    ]);
    const routes = enumerateRoutes(root, 'web', '');
    expect(routes.map((r) => r.pattern)).toEqual(['/', '/devices', '/devices/[id]']);
    expect(routes.find((r) => r.pattern === '/devices/[id]')?.dynamic).toBe(true);
    expect(routes.find((r) => r.pattern === '/devices')?.dynamic).toBe(false);
    expect(routes.every((r) => r.app === 'web')).toBe(true);
  });
});

describe('patternToRegex', () => {
  it('matches one path segment per [param] and anchors the whole path', () => {
    const re = patternToRegex('/devices/[id]');
    expect(re.test('/devices/abc-123')).toBe(true);
    expect(re.test('/devices/abc/extra')).toBe(false);
    expect(re.test('/devices')).toBe(false);
    expect(re.test('/x/devices/abc')).toBe(false);
  });

  it('matches one or more segments for a rest param', () => {
    const re = patternToRegex('/extensions/[name]/[...path]');
    expect(re.test('/extensions/foo/a/b/c')).toBe(true);
    expect(re.test('/extensions/foo')).toBe(false);
  });

  it('matches static siblings too — filtering those is resolveDynamicRoutes’ job', () => {
    expect(patternToRegex('/devices/[id]').test('/devices/compare')).toBe(true);
  });
});

describe('resolveDynamicRoutes', () => {
  const statics = new Set(['/devices', '/devices/compare', '/devices/groups']);

  it('picks the most frequently linked concrete href for each pattern', () => {
    const hrefs = [
      '/devices/compare',
      '/devices/d-1',
      '/devices/d-2?tab=overview',
      '/devices/d-2#hardware',
      'http://localhost:1234/alerts/a-9',
      'https://elsewhere.example.com/alerts/nope',
    ];
    const out = resolveDynamicRoutes(
      ['/devices/[id]', '/alerts/[id]', '/tickets/[id]'],
      hrefs,
      'http://localhost:1234',
      statics,
    );
    expect(out.resolved).toEqual({
      '/devices/[id]': '/devices/d-2',
      '/alerts/[id]': '/alerts/a-9',
    });
    expect(out.unresolved).toEqual(['/tickets/[id]']);
  });

  it('never resolves a pattern to a path that is itself a static page', () => {
    const out = resolveDynamicRoutes(['/devices/[id]'], ['/devices/groups'], 'http://h', statics);
    expect(out.resolved).toEqual({});
    expect(out.unresolved).toEqual(['/devices/[id]']);
  });

  it('lets explicit overrides win over harvested links', () => {
    const out = resolveDynamicRoutes(
      ['/devices/[id]'],
      ['/devices/d-1'],
      'http://h',
      statics,
      { '/devices/[id]': '/devices/pinned' },
    );
    expect(out.resolved['/devices/[id]']).toBe('/devices/pinned');
  });
});

describe('routeSlug', () => {
  it('produces a filesystem-safe, collision-resistant slug', () => {
    expect(routeSlug('/')).toBe('root');
    expect(routeSlug('/settings/sites')).toBe('settings__sites');
    expect(routeSlug('/devices/[id]')).toBe('devices___id_');
    expect(routeSlug('/portal')).toBe('portal');
  });
});
