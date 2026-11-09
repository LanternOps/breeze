/**
 * Static import-closure resolver for the worker/api role split (#4086, #4142).
 *
 * Extracted from `workerEntrypointClosure.contract.test.ts` so the contract
 * test and `scripts/worker-closure-report.ts` share ONE resolver. Pure static
 * analysis over source text: only `node:fs` / `node:path`, no TS compiler, no
 * runtime `import()` execution. See the contract test header for why both the
 * static-only and dynamic-following traversal modes exist.
 *
 * Additions over the original inline resolver: the optional `dropEdge` filter
 * on `importClosure` (used by the report CLI to preview "what if file X no
 * longer reached the socket-local modules"), the role-safe boundary modules,
 * and the `isSocketLocalClean` / registry-source helpers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This module lives in apps/api/src/services/workerClosure (ESM: no __dirname; works under vitest and tsx).
export const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'); // apps/api/src
export const REGISTRY_FILE = path.join(SRC_ROOT, 'services', 'workerRegistry.ts');
export const AGENT_WS = path.join(SRC_ROOT, 'routes', 'agentWs.ts');
export const AGENT_COMMAND_AWAIT = path.join(SRC_ROOT, 'services', 'agentCommandAwait.ts');
export const ROUTES_DIR = path.join(SRC_ROOT, 'routes') + path.sep;

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

const RESOLVABLE_EXTS = ['.ts', '.tsx'];

/** Resolves a relative import specifier to an on-disk file. Bare/package
 * specifiers (no leading `.`) return null — they're runtime-safe (node_modules
 * code doesn't reach our route graph) and out of scope for this walk. */
export function resolveRelativeSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    ...RESOLVABLE_EXTS.map((ext) => base + ext),
    ...RESOLVABLE_EXTS.map((ext) => path.join(base, `index${ext}`)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// `import ... from '<spec>'` / `export ... from '<spec>'`, excluding
// `import type` / `export type` (pure type-only — erased at compile time).
// Bounded by `[^;]*?` (not `[\s\S]*?`) so the non-greedy match can't cross a
// statement-terminating semicolon and accidentally swallow unrelated code
// between an `export function ...` keyword and some later, unrelated `from`
// token (e.g. inside a Drizzle query) — real import/export-from statements in
// this codebase are always semicolon-terminated, including multi-line ones.
const STATIC_FROM_RE = /\b(?:import|export)\s+(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/g;

// `import('<spec>')` / `await import('<spec>')` — dynamic loads.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Blanks out `//` and `/* *\/` comments (preserving string/template literal
 * contents verbatim, so quoted specifiers inside them still parse correctly)
 * before the import regexes run. Without this, prose like a JSDoc paragraph
 * that MENTIONS `import('./index')` as an example of a pattern the code
 * DELIBERATELY AVOIDS reads as a real dynamic-import edge — which is exactly
 * what `services/sentry.ts`'s header comment does, and which turned nearly
 * every entry's closure into a false-positive hit on `services/commandQueue.ts`
 * (then a module whose closure reached `routes/agentWs.ts`) via `services/index.ts`'s
 * barrel `export * from './commandQueue'` — a graph edge that exists only in
 * a code sample inside a comment, not in `services/sentry.ts`'s real imports.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          out += src[i];
          i++;
          if (i < n) {
            out += src[i];
            i++;
          }
          continue;
        }
        out += src[i];
        i++;
      }
      if (i < n) {
        out += src[i];
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export interface ParsedFile {
  staticSpecs: string[];
  dynamicSpecs: string[];
}

const parseCache = new Map<string, ParsedFile>();

export function parseFile(file: string): ParsedFile {
  const cached = parseCache.get(file);
  if (cached) return cached;
  const content = stripComments(fs.readFileSync(file, 'utf8'));
  const staticSpecs = [...content.matchAll(STATIC_FROM_RE)].map((m) => m[1]!);
  const dynamicSpecs = [...content.matchAll(DYNAMIC_IMPORT_RE)].map((m) => m[1]!);
  const parsed: ParsedFile = { staticSpecs, dynamicSpecs };
  parseCache.set(file, parsed);
  return parsed;
}

/**
 * Role-safe boundary modules (#4141): the walk records them but does NOT
 * traverse their imports. `services/agentCommandRelay.ts` is the ONE module
 * designed to be loaded by every placement: its only socket-local access is a
 * dynamic `import('../routes/agentWs')` inside `breezeRole() !== 'worker'`
 * guards, and 3.5b's runtime assertions make any illegal call THROW rather
 * than silently report agents offline. Treating it as a leaf is what lets the
 * facade's callers (monitor/snmp/backup/discovery/networkBaseline) be
 * `global` — the entire point of the relay. Any OTHER path to agentWs still
 * classifies an entry socket-owner.
 */
export const AGENT_COMMAND_RELAY = path.join(SRC_ROOT, 'services', 'agentCommandRelay.ts');
export const ROLE_SAFE_BOUNDARY_MODULES: ReadonlySet<string> = new Set([AGENT_COMMAND_RELAY]);

/** An edge filter: return true to DROP the edge `from -> to` (it is not followed). */
export type EdgeFilter = (from: string, to: string) => boolean;

/**
 * Transitive closure of relative-import edges reachable from `entryFile`,
 * as absolute file paths (entryFile itself included). `followDynamic`
 * chooses whether `import('...')` edges are traversed — see the header
 * comment in `workerEntrypointClosure.contract.test.ts` for why both modes
 * are needed.
 */
export function importClosure(
  entryFile: string,
  opts: { followDynamic: boolean; dropEdge?: EdgeFilter },
): Set<string> {
  const visited = new Set<string>();
  const stack: string[] = [entryFile];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    if (file !== entryFile && ROLE_SAFE_BOUNDARY_MODULES.has(file)) continue;
    const { staticSpecs, dynamicSpecs } = parseFile(file);
    const specs = opts.followDynamic ? [...staticSpecs, ...dynamicSpecs] : staticSpecs;
    for (const spec of specs) {
      const resolved = resolveRelativeSpec(file, spec);
      if (!resolved || visited.has(resolved)) continue;
      if (opts.dropEdge?.(file, resolved)) continue;
      stack.push(resolved);
    }
  }
  return visited;
}

/** Per-entry placement check (test 2): narrower than the entrypoint check —
 * a `global`-placement job module is allowed to transitively reach some
 * unrelated route file (e.g. a shared Zod schema module under `routes/`,
 * which is inert data, not socket dispatch code); it must only avoid the two
 * modules that actually hold live agent-socket state / dispatch. Reaching
 * `routes/agentWs.ts` or `services/agentCommandAwait.ts` is what pulls in a
 * module-scope socket registry, not merely landing under `routes/`. */
export function socketLocalOffenders(closure: Set<string>): string[] {
  return [...closure].filter((f) => f === AGENT_WS || f === AGENT_COMMAND_AWAIT);
}

export function relPath(file: string): string {
  return path.relative(SRC_ROOT, file).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Registry source parsing — (name, placement, load-target-spec) triples,
// read straight from workerRegistry.ts's source text rather than via the
// live `WORKER_REGISTRY` import, because the load spec (the string literal
// argument to `await import(...)`) isn't part of the `WorkerRegistration`
// TYPE (only the thunk function value is) and this test must never actually
// INVOKE `load()` — doing so would run the real job module's init-adjacent
// module-scope code. `WORKER_REGISTRY` itself IS imported below, but only
// its plain `name`/`placement` string fields are read.
// ---------------------------------------------------------------------------

export interface RegistryEntrySource {
  name: string;
  placement: string;
  spec: string;
}

const ENTRY_SOURCE_RE =
  /name:\s*'([^']+)'[\s\S]*?placement:\s*'([^']+)'[\s\S]*?await import\(\s*['"]([^'"]+)['"]\s*\)/g;

export function parseRegistrySource(): RegistryEntrySource[] {
  // stripComments matters here too: one entry's placement doc-comment
  // literally quotes `await import('../routes/agentWs')` while explaining a
  // DIFFERENT module's runtime path (see offboardingDrainReaper's comment in
  // workerRegistry.ts) — without stripping, a naive regex could pick up that
  // quoted mention instead of (or alongside) the entry's own real `load()`
  // import spec.
  const content = stripComments(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  return [...content.matchAll(ENTRY_SOURCE_RE)].map((m) => ({
    name: m[1]!,
    placement: m[2]!,
    spec: m[3]!,
  }));
}

/**
 * True when the entry's `load()` target has no socket-local module
 * (`routes/agentWs.ts`, `services/agentCommandAwait.ts`) in its
 * dynamic-following import closure, i.e. it could be placed `global`. Throws
 * when the spec does not resolve (a silent `false` would hide a broken
 * registry entry).
 */
export function isSocketLocalClean(entry: RegistryEntrySource, dropEdge?: EdgeFilter): boolean {
  const target = resolveRelativeSpec(REGISTRY_FILE, entry.spec);
  if (!target) {
    throw new Error(`could not resolve load() spec "${entry.spec}" for entry "${entry.name}"`);
  }
  return socketLocalOffenders(importClosure(target, { followDynamic: true, dropEdge })).length === 0;
}
