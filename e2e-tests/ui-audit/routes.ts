import { readdirSync } from 'node:fs';
import path from 'node:path';
import type { AppName } from './types';

export interface RouteEntry {
  app: AppName;
  pattern: string;
  dynamic: boolean;
  /** Page file, relative to the app's pages dir. */
  file: string;
}

/** `devices/[id].astro` + prefix → `/devices/[id]`; `index.astro` → the directory. */
export function fileToPattern(relFile: string, prefix: string): string {
  const noExt = relFile.replace(/\\/g, '/').replace(/\.astro$/, '');
  const parts = noExt.split('/').filter(Boolean);
  if (parts[parts.length - 1] === 'index') parts.pop();
  const route = `${prefix}/${parts.join('/')}`.replace(/\/+$/, '');
  return route === '' ? '/' : route;
}

export function enumerateRoutes(pagesDir: string, app: AppName, prefix: string): RouteEntry[] {
  const out: RouteEntry[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('_')) continue; // __tests__, _partials
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.name.endsWith('.astro')) {
        const file = path.relative(pagesDir, abs);
        const pattern = fileToPattern(file, prefix);
        out.push({ app, pattern, dynamic: pattern.includes('['), file });
      }
    }
  };
  walk(pagesDir);
  return out.sort((a, b) => a.pattern.localeCompare(b.pattern));
}

export function patternToRegex(pattern: string): RegExp {
  const body = pattern
    .split('/')
    .map((seg) => {
      if (/^\[\.\.\..+\]$/.test(seg)) return '.+';
      if (/^\[.+\]$/.test(seg)) return '[^/]+';
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${body}$`);
}

/**
 * Pick one concrete path per dynamic pattern from hrefs harvested off the
 * static pages. The most-linked candidate wins (it is usually the seeded
 * record every list page points at); ties go to first seen.
 */
export function resolveDynamicRoutes(
  patterns: string[],
  hrefs: string[],
  origin: string,
  staticPaths: Set<string>,
  overrides: Record<string, string> = {},
): { resolved: Record<string, string>; unresolved: string[] } {
  const counts = new Map<string, number>();
  for (const href of hrefs) {
    let url: URL;
    try {
      url = new URL(href, origin);
    } catch {
      continue;
    }
    if (url.origin !== new URL(origin).origin) continue;
    const p = url.pathname.replace(/\/+$/, '') || '/';
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }

  const resolved: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const pattern of patterns) {
    if (overrides[pattern]) {
      resolved[pattern] = overrides[pattern];
      continue;
    }
    const re = patternToRegex(pattern);
    let best: string | undefined;
    let bestCount = 0;
    for (const [p, n] of counts) {
      if (staticPaths.has(p) || !re.test(p)) continue;
      if (n > bestCount) {
        best = p;
        bestCount = n;
      }
    }
    if (best) resolved[pattern] = best;
    else unresolved.push(pattern);
  }
  return { resolved, unresolved };
}

export function routeSlug(route: string): string {
  const trimmed = route.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return 'root';
  return trimmed.replace(/\//g, '__').replace(/[^a-zA-Z0-9_-]/g, '_');
}
