import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// `/automations` navigates on its own, so the page must start no token refresh:
// a navigation that cuts off a refresh in flight can leave the old refresh
// cookie behind and sign the person out (#9476). The auth store and everything
// built on it can start one, so neither the island's static import graph nor
// the page's layout may reach them.
const SRC = join(process.cwd(), 'src');
const ISLAND = join(SRC, 'components/automations/AutomationsRedirect.tsx');
const PAGE = join(SRC, 'pages/automations/index.astro');

const FORBIDDEN = [
  /\/stores\/auth(\.tsx?)?$/,
  /\/stores\/featuresStore(\.tsx?)?$/,
];

const SPECIFIER = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveLocal(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else return null; // packages cannot reach the web app's stores
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
  return candidates.find((c) => statSync(c, { throwIfNoEntry: false })?.isFile()) ?? null;
}

/** Every local module reachable from `entry` through static or dynamic imports. */
function importGraph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(SPECIFIER)) {
      const spec = match[1] ?? match[2] ?? match[3];
      const target = resolveLocal(file, spec);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return [...seen].map((f) => `/${relative(SRC, f)}`.replace(/\.(tsx?|astro)$/, ''));
}

describe('/automations starts no token refresh', () => {
  it('the redirect island never reaches the auth store or the features store', () => {
    const graph = importGraph(ISLAND);
    expect(graph).toContain('/components/automations/AutomationsRedirect');
    expect(graph.filter((m) => FORBIDDEN.some((re) => re.test(m)))).toEqual([]);
  });

  it('the page uses a layout without the session manager or the client router', () => {
    // Code only: the files explain in comments why they avoid these names.
    const code = (file: string) => readFileSync(file, 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const page = code(PAGE);
    const layoutImport = page.match(/import\s+\w+\s+from\s+['"](\.[^'"]+\/layouts\/[^'"]+\.astro)['"]/);
    expect(layoutImport, 'pages/automations/index.astro imports a layout').not.toBeNull();
    const layoutPath = resolve(dirname(PAGE), layoutImport![1]);
    const layout = code(layoutPath);

    // The session manager starts a refresh on mount.
    expect(page).not.toContain('AdminSessionManager');
    expect(layout).not.toContain('AdminSessionManager');
    expect(layout).not.toContain('DashboardLayout');
    expect(layout).not.toMatch(/import\s+\w+\s+from\s+['"]\.\/Layout\.astro['"]/);
    // Without the router, a soft navigation into /automations becomes a full
    // load, so the old page's auth store never runs on this page.
    expect(layout).not.toContain('<ClientRouter');
    expect(layout).not.toContain('astro:transitions');

    // Every client island the page and its layout mount stays off the auth store.
    for (const source of [page, layout]) {
      for (const match of source.matchAll(/import\s+\w+\s+from\s+['"](\.[^'"]+)['"]/g)) {
        const target = resolveLocal(source === page ? PAGE : layoutPath, match[1]);
        if (!target || target.endsWith('.astro')) continue;
        expect(importGraph(target).filter((m) => FORBIDDEN.some((re) => re.test(m)))).toEqual([]);
      }
    }
  });
});
