import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// apps/api/src/config -> repo root is 4 levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const segments = [...new Set(
  readdirSync(path.join(REPO_ROOT, 'apps/web/src/pages/billing'), { withFileTypes: true })
    .flatMap(entry => entry.isDirectory()
      ? [entry.name]
      : entry.isFile() && entry.name.endsWith('.astro')
        ? [entry.name.slice(0, -'.astro'.length)]
        : []),
)].sort();
const caddyfile = readFileSync(path.join(REPO_ROOT, 'docker/Caddyfile.prod'), 'utf8')
  .replace(/#[^\n]*/g, '');
const sidecarIndex = caddyfile.search(/^\s*@billing\s+path\s+\/billing\s+\/billing\/\*\s*$/m);
const matchers = [...caddyfile.matchAll(/^\s*(@\w+)\s+path\s+([^\n]+)/gm)];
const handles = [...caddyfile.matchAll(/^\s*handle\s+(@\w+)\s*\{([^{}]*)\}/gm)];

describe('Caddy web billing carve-outs', () => {
  it('discovers billing pages and the sidecar fallback', () => {
    expect(segments.length).toBeGreaterThan(0);
    expect(sidecarIndex).toBeGreaterThanOrEqual(0);
  });

  it.each(segments)('routes /billing/%s and its descendants to web before the sidecar', segment => {
    const carveout = matchers.find(matcher => {
      const paths = matcher[2]!.trim().split(/\s+/);
      return matcher.index! < sidecarIndex
        && paths.includes(`/billing/${segment}`)
        && paths.includes(`/billing/${segment}/*`)
        && handles.some(handle => handle[1] === matcher[1]
          && handle.index! < sidecarIndex
          && /^\s*reverse_proxy\s+web:4321\s*$/m.test(handle[2]!));
    });
    expect(carveout, `/billing/${segment} needs an explicit web:4321 carve-out before @billing`).toBeDefined();
  });
});
