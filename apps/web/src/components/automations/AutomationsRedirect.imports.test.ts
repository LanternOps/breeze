import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// `/automations` navigates on its own, so the page must start no token refresh:
// a navigation that cuts off a refresh in flight can leave the old refresh
// cookie behind and sign the person out (#9476). The auth store and everything
// built on it can start one, so nothing the page loads may reach them: not the
// island, not the layout, not a component or a <script> either of them pulls in.
const SRC = join(process.cwd(), 'src');
const ISLAND = join(SRC, 'components/automations/AutomationsRedirect.tsx');
const PAGE = join(SRC, 'pages/automations/index.astro');

const FORBIDDEN = [
  /\/stores\/auth(\/index)?$/,
  /\/stores\/featuresStore(\/index)?$/,
];

// Imports the walk does not follow: they cannot load a store.
const ASSET = /\.(css|scss|svg|png|jpe?g|gif|webp|ico|woff2?|json)(\?.*)?$/;

const SPECIFIER = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"`]([^'"`]+)['"`]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Code only: an apostrophe in a comment must not end a match early. Keeps `://` in strings. */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\w])\/\/.*$/gm, '$1');
}

function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.') && !spec.startsWith('@/')) return null; // packages cannot reach the web app's stores
  if (ASSET.test(spec)) return null;
  const bare = spec.replace(/\?.*$/, '');
  const base = bare.startsWith('@/') ? join(SRC, bare.slice(2)) : resolve(dirname(fromFile), bare);
  const noJs = base.replace(/\.(m?js|jsx)$/, '');
  const candidates = [
    base,
    ...['.ts', '.tsx', '.astro', '.js', '.mjs'].map((ext) => `${noJs}${ext}`),
    ...['index.ts', 'index.tsx', 'index.js'].map((name) => join(base, name)),
  ];
  const found = candidates.find((c) => statSync(c, { throwIfNoEntry: false })?.isFile());
  // Fail closed: an import the walk cannot follow could be the one that loads the store.
  if (!found) throw new Error(`${relative(SRC, fromFile)}: cannot resolve import '${spec}'`);
  return found;
}

/** Every local module reachable from `entry` through static, dynamic and <script> imports, .astro files included. */
function importGraph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(SPECIFIER)) {
      const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
      const target = resolveLocal(file, spec);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return [...seen].map((f) => `/${relative(SRC, f)}`.replace(/\.(tsx?|astro|m?js)$/, ''));
}

const forbiddenIn = (graph: string[]) => graph.filter((m) => FORBIDDEN.some((re) => re.test(m)));

function layoutOf(pageCode: string): string {
  const layoutImport = pageCode.match(/import\s+\w+\s+from\s+['"](\.[^'"]+\/layouts\/[^'"]+\.astro)['"]/);
  expect(layoutImport, 'pages/automations/index.astro imports a layout').not.toBeNull();
  return resolve(dirname(PAGE), layoutImport![1]);
}

describe('/automations starts no token refresh', () => {
  it('the walker sees a real store import (not vacuous)', () => {
    // The session manager loads the auth store; if the walk could not see that, every check below would pass for nothing.
    const graph = importGraph(join(SRC, 'components/auth/AdminSessionManager.tsx'));
    expect(forbiddenIn(graph)).toContain('/stores/auth');
  });

  it('the redirect island never reaches the auth store or the features store', () => {
    const graph = importGraph(ISLAND);
    expect(graph).toContain('/components/automations/AutomationsRedirect');
    expect(forbiddenIn(graph)).toEqual([]);
  });

  it('nothing the page loads reaches the auth store or the features store', () => {
    const graph = importGraph(PAGE);
    expect(graph).toContain('/components/automations/AutomationsRedirect');
    expect(graph.some((m) => m.startsWith('/layouts/'))).toBe(true);
    expect(forbiddenIn(graph)).toEqual([]);
  });

  it('the page uses a layout without the session manager, the client router or a bundled script', () => {
    const pageCode = stripComments(readFileSync(PAGE, 'utf8'));
    const layout = stripComments(readFileSync(layoutOf(pageCode), 'utf8'));

    // The session manager starts a refresh on mount.
    for (const code of [pageCode, layout]) {
      expect(code).not.toContain('AdminSessionManager');
      expect(code).not.toContain('DashboardLayout');
    }
    expect(layout).not.toMatch(/from\s+['"]\.\/Layout\.astro['"]/);
    // Without the router, a soft navigation into /automations becomes a full
    // load, so the old page's auth store never runs on this page.
    expect(layout).not.toContain('<ClientRouter');
    expect(layout).not.toContain('astro:transitions');
    // Only external public scripts (`is:inline src=`): a bundled <script> could import anything.
    for (const code of [pageCode, layout]) {
      for (const tag of code.match(/<script\b[^>]*>/g) ?? []) {
        expect(tag).toMatch(/\bis:inline\b/);
        expect(tag).toMatch(/\bsrc=/);
      }
    }
  });
});
