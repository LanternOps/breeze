import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_SCHEMA, defineMappingTag, defineScalarTag, defineSequenceTag, load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

// apps/api/src/config -> repo root is 4 levels up (same as composeBindMounts.test.ts).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Why this test exists (#11623)
 * -----------------------------
 * The dev web and portal containers run the Astro dev server against the
 * worktree through bind mounts. A file the astro/vite config loads that no
 * mount covers is read from the IMAGE instead, so it works only for whoever
 * built the image after that file landed. #11544 added
 * `packages/shared/zodJitlessAlias.mjs` and imported it from both astro configs
 * while the stacks mounted only `packages/shared/src`: every dev image built
 * before it crash-looped with `Failed to load url ../../packages/shared/...`,
 * and the nightly perf gate went red for days.
 *
 * The guard: for each stack composition that runs these services, every
 * workspace file reachable from an app's astro/vite config (the config itself,
 * its relative imports, `new URL('./x', import.meta.url)` references, and
 * `@breeze/*` workspace-package imports, followed transitively) must sit under a
 * bind mount that maps it to the same path under /app.
 */

/** The compositions that run web/portal from source, in `-f` order. */
const STACKS: Record<string, string[]> = {
  // docker compose -f docker-compose.yml -f docker-compose.override.yml.dev
  dev: ['docker-compose.yml', 'docker-compose.override.yml.dev'],
  // scripts/dev/wt-stack/compose.ts composeArgs()
  'wt-stack': ['docker-compose.yml', 'docker-compose.override.yml.dev', 'docker-compose.override.yml.worktree'],
  // docker compose -f docker-compose.dev.yml (standalone; defines web, no portal)
  'compose-dev': ['docker-compose.dev.yml'],
};

/** Compose service -> the app directory it serves (WORKDIR /app/<dir>). */
const SERVICES: Record<string, string> = { web: 'apps/web', portal: 'apps/portal' };

const CONFIG_FILE = /^(astro|vite)\.config\.(mjs|js|cjs|mts|ts)$/;

// --- Compose loading. `!reset` / `!override` replace the merged value; record
// which one was used so the merge below can honour it.
type Tagged = { __tag: '!reset' | '!override'; value: unknown };
const tagged = (tag: Tagged['__tag']) => [
  defineSequenceTag<Tagged>(tag, {
    identify: () => false,
    create: () => ({ __tag: tag, value: [] }),
    addItem: (t, item) => {
      (t.value as unknown[]).push(item);
    },
  }),
  defineMappingTag<Tagged>(tag, {
    identify: () => false,
    create: () => ({ __tag: tag, value: {} }),
    addPair: (t, key, value) => {
      (t.value as Record<string, unknown>)[String(key)] = value;
      return '';
    },
    has: (t, key) => String(key) in (t.value as Record<string, unknown>),
    keys: (t) => Object.keys(t.value as Record<string, unknown>)[Symbol.iterator](),
    get: (t, key) => (t.value as Record<string, unknown>)[String(key)],
  }),
];
// Scalar forms (`!reset null`) only appear on fields this test never reads; js-yaml
// would throw on an unknown tag, so accept and ignore them.
const SCHEMA = CORE_SCHEMA.withTags([
  ...tagged('!reset'),
  ...tagged('!override'),
  defineScalarTag('!reset', { resolve: () => true, identify: () => false }),
  defineScalarTag('!override', { resolve: () => true, identify: () => false }),
]);

interface Bind {
  source: string; // repo-relative, normalised
  target: string;
}

function parseVolume(v: unknown): { target: string; bind: Bind | null } | null {
  let source: string | undefined;
  let target: string | undefined;
  if (typeof v === 'string') {
    const parts = v.split(':');
    if (parts.length === 1) target = parts[0];
    else [source, target] = parts;
  } else if (v && typeof v === 'object') {
    const long = v as { type?: string; source?: string; target?: string };
    target = long.target;
    if (long.type === 'bind') source = long.source;
  }
  if (!target) return null;
  if (!source || !(source.startsWith('./') || source.startsWith('../') || source === '.')) {
    return { target, bind: null }; // anonymous/named volume: shadows, never provides worktree files
  }
  return { target, bind: { source: path.posix.normalize(source), target: path.posix.normalize(target) } };
}

/** Effective volumes of `service` after merging `files` the way Compose does (keyed by target). */
function effectiveVolumes(files: string[], service: string): Map<string, Bind | null> {
  let merged = new Map<string, Bind | null>();
  for (const file of files) {
    const doc = load(readFileSync(path.join(REPO_ROOT, file), 'utf8'), { schema: SCHEMA }) as {
      services?: Record<string, { volumes?: unknown }>;
    } | null;
    const raw = doc?.services?.[service]?.volumes;
    if (raw === undefined) continue;
    let list: unknown[];
    if (raw && typeof raw === 'object' && '__tag' in (raw as object)) {
      merged = new Map();
      list = ((raw as Tagged).value as unknown[]) ?? [];
    } else {
      list = Array.isArray(raw) ? raw : [];
    }
    for (const v of list) {
      const parsed = parseVolume(v);
      if (parsed) merged.set(path.posix.normalize(parsed.target), parsed.bind);
    }
  }
  return merged;
}

function definesService(files: string[], service: string): boolean {
  return files.some((file) => {
    const doc = load(readFileSync(path.join(REPO_ROOT, file), 'utf8'), { schema: SCHEMA }) as {
      services?: Record<string, unknown>;
    } | null;
    return Boolean(doc?.services && service in doc.services);
  });
}

/**
 * The container sees `/app/<rel>` from the worktree only when the deepest mount
 * covering that path is a bind of `./<rel-prefix>` onto `/app/<rel-prefix>`.
 */
function coverage(volumes: Map<string, Bind | null>, rel: string): 'live' | 'shadowed' | 'image' {
  const inContainer = path.posix.join('/app', rel);
  let best: { target: string; bind: Bind | null } | null = null;
  for (const [target, bind] of volumes) {
    if (inContainer === target || inContainer.startsWith(`${target}/`)) {
      if (!best || target.length > best.target.length) best = { target, bind };
    }
  }
  if (!best) return 'image';
  if (!best.bind) return 'shadowed';
  const expected = path.posix.normalize(path.posix.join('.', path.posix.relative('/app', best.target)));
  return path.posix.normalize(best.bind.source) === expected || `./${expected}` === best.bind.source ? 'live' : 'image';
}

// --- Config reference graph.
function workspacePackages(): Map<string, string> {
  const out = execFileSync('git', ['ls-files', '-z', 'packages/*/package.json', 'apps/*/package.json', 'ee/*/package.json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const map = new Map<string, string>();
  for (const f of out.split('\0').filter(Boolean)) {
    const name = (JSON.parse(readFileSync(path.join(REPO_ROOT, f), 'utf8')) as { name?: string }).name;
    if (name) map.set(name, path.posix.dirname(f));
  }
  return map;
}

function resolveFile(absNoExt: string): string | null {
  const candidates = [absNoExt, ...['.mjs', '.js', '.ts', '.mts', '.cjs'].map((e) => absNoExt + e)];
  candidates.push(...['index.mjs', 'index.js', 'index.ts'].map((i) => path.join(absNoExt, i)));
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

function resolveWorkspaceImport(spec: string, packages: Map<string, string>): string | null | undefined {
  const m = spec.match(/^(@breeze\/[^/]+)(\/.*)?$/);
  if (!m) return undefined; // a third-party package: comes from node_modules, not the worktree
  const dir = packages.get(m[1]!);
  if (!dir) return null;
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, dir, 'package.json'), 'utf8')) as {
    main?: string;
    exports?: string | Record<string, unknown>;
  };
  const sub = m[2] ? `.${m[2]}` : '.';
  let target: unknown = typeof pkg.exports === 'string' ? (sub === '.' ? pkg.exports : undefined) : pkg.exports?.[sub];
  if (target && typeof target === 'object') {
    const conds = target as Record<string, unknown>;
    target = conds.import ?? conds.default ?? conds.node;
  }
  if (target === undefined && sub === '.') target = pkg.main;
  if (typeof target !== 'string') return null;
  return resolveFile(path.join(REPO_ROOT, dir, target));
}

/**
 * A `../`-relative path literal the import/URL scan did not pick up — e.g. one
 * handed to `path.resolve`, `require` or `createRequire` — reaches outside the
 * file's own directory by some route this test cannot follow. Fail closed on it
 * rather than let the closure silently miss a file. Globs are not file paths.
 */
function unfollowedPathLiterals(src: string, followed: string[]): string[] {
  return [...src.matchAll(/['"`]((?:\.\.\/)+[^'"`\s*{}$]+)['"`]/g)].map((m) => m[1]!).filter((lit) => !followed.includes(lit));
}

/** Repo-relative paths of every workspace file the config loads, transitively. */
function configClosure(configRel: string, packages: Map<string, string>): { files: string[]; unresolved: string[] } {
  const seen = new Set<string>();
  const unresolved: string[] = [];
  const queue = [path.join(REPO_ROOT, configRel)];
  while (queue.length) {
    const abs = queue.pop()!;
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!/\.(mjs|js|cjs|mts|ts)$/.test(abs)) continue;
    const src = readFileSync(abs, 'utf8');
    const specs = [
      ...src.matchAll(/^\s*(?:import|export)\s[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm),
      ...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
      ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]!);
    const urls = [...src.matchAll(/new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)].map((m) => m[1]!);
    for (const lit of unfollowedPathLiterals(src, [...specs, ...urls])) {
      unresolved.push(`${rel}: path literal ${lit} is loaded some way this scanner does not follow`);
    }
    for (const spec of [...specs, ...urls]) {
      if (spec.startsWith('node:')) continue;
      let next: string | null | undefined;
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const base = path.resolve(path.dirname(abs), spec);
        next = urls.includes(spec) ? (existsSync(base) ? base : null) : resolveFile(base);
      } else {
        next = resolveWorkspaceImport(spec, packages);
        if (next === undefined) continue;
      }
      if (next === null) unresolved.push(`${rel}: ${spec}`);
      else queue.push(next);
    }
  }
  return { files: [...seen].sort(), unresolved };
}

function configsOf(appDir: string): string[] {
  const out = execFileSync('git', ['ls-files', '-z', appDir], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out
    .split('\0')
    .filter((f) => f && path.posix.dirname(f) === appDir && CONFIG_FILE.test(path.posix.basename(f)))
    .sort();
}

const packages = workspacePackages();

describe('dev web/portal containers see every file their astro/vite config loads (#11623)', () => {
  for (const [service, appDir] of Object.entries(SERVICES)) {
    const configs = configsOf(appDir);

    it(`${appDir} has an astro/vite config to check`, () => {
      expect(configs.length, `${appDir}: expected an astro.config.* — has the app moved?`).toBeGreaterThan(0);
    });

    for (const config of configs) {
      const { files, unresolved } = configClosure(config, packages);

      it(`${config}: every reference resolves to a workspace file`, () => {
        expect(unresolved, 'unresolvable reference — extend this test or fix the path').toEqual([]);
        expect(files, 'the closure follows the config into the workspace').toContain(config);
      });

      for (const [stack, composeFiles] of Object.entries(STACKS)) {
        if (!definesService(composeFiles, service)) continue;
        it(`${stack} stack: ${service} bind-mounts every file ${config} loads`, () => {
          const volumes = effectiveVolumes(composeFiles, service);
          expect(volumes.size, `${stack}: ${service} has no volumes — is it still source-mounted?`).toBeGreaterThan(0);
          const notLive = files
            .map((f) => ({ f, c: coverage(volumes, f) }))
            .filter(({ c }) => c !== 'live')
            .map(({ f, c }) => `${f} (${c === 'image' ? 'image-only: stale for any image built before it changed' : 'shadowed by a volume'})`);
          expect(
            notLive,
            `${stack} stack, service ${service}: mount these (prefer the package directory over single files) in ${composeFiles.slice(1).join(' / ')}`,
          ).toEqual([]);
        });
      }
    }

    // A whole-package bind hides the image's node_modules under it unless a
    // volume shields that path; on the host it holds the host's own install
    // (macOS binaries, host symlinks), so the container would crash-loop again.
    for (const [stack, composeFiles] of Object.entries(STACKS)) {
      if (!definesService(composeFiles, service)) continue;
      it(`${stack} stack: ${service} keeps the image's node_modules under every whole-package bind`, () => {
        const volumes = effectiveVolumes(composeFiles, service);
        const unshielded = [...volumes.values()]
          .filter((b): b is Bind => b !== null && existsSync(path.join(REPO_ROOT, b.source, 'package.json')))
          .filter((b) => !(volumes.has(`${b.target}/node_modules`) && volumes.get(`${b.target}/node_modules`) === null))
          .map((b) => `${b.source} -> ${b.target} (add a "- ${b.target}/node_modules" volume)`);
        expect(unshielded).toEqual([]);
      });
    }
  }

  it("the wt-stack composition matches scripts/dev/wt-stack/compose.ts composeArgs()", () => {
    const src = readFileSync(path.join(REPO_ROOT, 'scripts/dev/wt-stack/compose.ts'), 'utf8');
    const body = src.match(/export function composeArgs\([^)]*\)[^{]*\{([\s\S]*?)\n\}/)?.[1];
    expect(body, 'composeArgs() in compose.ts').toBeDefined();
    const files = [...body!.matchAll(/'-f',\s*'([^']+)'/g)].map((m) => m[1]);
    expect(files).toEqual(STACKS['wt-stack']);
  });
});

describe('composeConfigImportMounts helpers', () => {
  const vols = new Map<string, Bind | null>([
    ['/app/packages/shared', { source: './packages/shared', target: '/app/packages/shared' }],
    ['/app/packages/shared/node_modules', null],
    ['/app/apps/web/astro.config.mjs', { source: './apps/web/astro.config.mjs', target: '/app/apps/web/astro.config.mjs' }],
    ['/app/apps/x', { source: './elsewhere', target: '/app/apps/x' }],
  ]);

  it('classifies live, image-only and shadowed paths', () => {
    expect(coverage(vols, 'packages/shared/zodJitlessAlias.mjs')).toBe('live');
    expect(coverage(vols, 'packages/shared/node_modules/zod/index.js')).toBe('shadowed');
    expect(coverage(vols, 'apps/web/astro.config.mjs')).toBe('live');
    expect(coverage(vols, 'apps/web/src/env.d.ts')).toBe('image');
    expect(coverage(vols, 'apps/x/a.ts'), 'a bind that maps a different source is not live').toBe('image');
  });

  it('follows the real zod alias from the web config into packages/shared/src', () => {
    const { files } = configClosure('apps/web/astro.config.mjs', packages);
    expect(files).toEqual(expect.arrayContaining(['packages/shared/zodJitlessAlias.mjs', 'packages/shared/src/zodJitlessShim.ts']));
  });

  it('fails closed on a ../ path literal the import scan did not follow', () => {
    const src = [
      "import { a } from '../../packages/shared/a.mjs';",
      "const b = path.resolve(here, '../../packages/foo/b.mjs');",
      "const glob = '../src/**/*.ts';",
    ].join('\n');
    expect(unfollowedPathLiterals(src, ['../../packages/shared/a.mjs'])).toEqual(['../../packages/foo/b.mjs']);
  });

  it('honours !reset when merging volumes', () => {
    // postgres: the worktree override resets the dev volumes to [].
    expect(effectiveVolumes(STACKS['wt-stack']!, 'postgres').size).toBe(0);
  });
});
