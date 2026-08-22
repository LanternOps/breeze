import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Contract test: every hand-authored app-internal link in the portal must go
 * through `withBase()`.
 *
 * The portal is served under a base path (`/portal` by default). Astro prefixes
 * its own asset URLs and route matching, but NOT hand-written `href`,
 * `Astro.redirect(...)`, or `window.location.*` strings — those 404 (or escape
 * into the MSP web app) when the base is non-empty. This shipped once already:
 * the whole `/quotes` area was authored after the convention landed and missed
 * it in all five of its call sites, so proposal links in the portal pointed at
 * `/quotes/<id>` instead of `/portal/quotes/<id>`.
 *
 * Code review has no reliable way to spot an omission here (the code is
 * self-consistent and looks right), so it is enforced mechanically instead.
 *
 * If you need an exception, prefer restructuring over an allowlist — the only
 * legitimate non-based absolute paths are API calls, which must go through
 * `buildPortalApiUrl()` (and are matched as such below).
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (entry === 'node_modules') return [];
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(tsx|astro)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Patterns that produce a navigable URL from a literal absolute path. */
const OFFENDERS: Array<{ label: string; re: RegExp }> = [
  // href="/foo" or href={`/foo/${x}`} — but not href={withBase(...)}, mailto:, tel:, http(s):, #anchor
  { label: 'href', re: /\bhref=(?:"\/(?!\/)|\{`\/(?!\/))/g },
  // Astro.redirect('/foo') / redirect(`/foo`)
  { label: 'redirect', re: /\bredirect\(\s*['"`]\//g },
  // window.location.href = '/foo' / .replace('/foo') / .assign('/foo')
  { label: 'window.location', re: /\blocation\.(?:href\s*=\s*|replace\(|assign\()\s*['"`]\//g },
];

describe('portal base-path coverage', () => {
  const files = walk(SRC);

  it('finds portal source files to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(OFFENDERS)('no un-based $label to an app-internal path', ({ re }) => {
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');
      lines.forEach((line, i) => {
        // API paths are same-origin under /api/v1 and correctly bypass the base.
        if (/buildPortalApiUrl|['"`]\/api\//.test(line)) return;
        for (const match of line.matchAll(new RegExp(re.source, 'g'))) {
          void match;
          violations.push(`${relative(SRC, file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }

    expect(violations, `Wrap these in withBase():\n${violations.join('\n')}`).toEqual([]);
  });
});


describe('rendered API links use publicApiPath, never the SSR-internal base', () => {
  it('no href/src is built with buildPortalApiUrl', () => {
    const { readdirSync, readFileSync, statSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const root = new URL('../', import.meta.url).pathname;
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const full = join(d, e);
        if (statSync(full).isDirectory()) { if (e !== 'node_modules') walk(full); }
        else if (/\.(tsx|astro)$/.test(e) && !/\.test\./.test(e)) files.push(full);
      }
    };
    walk(root);
    const offenders = files.filter((f) => /(href|src)=\{buildPortalApiUrl\(/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
