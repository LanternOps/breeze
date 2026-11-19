// Dependency scope of every package in a pnpm-lock.yaml (lockfileVersion 9),
// for the dependency audit's base/head comparison (#11137).
//
// A package is "production" when it is reachable from any importer's
// `dependencies` or `optionalDependencies` (optional packages ship, so they are
// production), "dev" when it is reachable only from `devDependencies`, and
// "unknown" when the walk never placed it. Consumers treat unknown as
// production: a scope that cannot be determined fails closed.
//
// A hand-rolled reader, not a YAML parser: the audit job runs on a bare
// checkout and the lockfile's importers/snapshots shape is rigid.
//
// CLI: node lockfile-scope.mjs <pnpm-lock.yaml>
//   prints {"name@version": "production"|"dev", ...} (unplaced packages are
//   absent); exits 1 with a message on stderr when the lockfile cannot be walked.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const unquote = (s) => s.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
const stripPeers = (s) => {
  const i = s.indexOf('(');
  return i === -1 ? s : s.slice(0, i);
};

// "name@1.2.3(peer@1)" → "name@1.2.3"
const snapshotId = (key) => stripPeers(unquote(key));

// The snapshot key a `name: value` dependency edge resolves to, or null for
// edges that are not registry packages (link:, file:, workspace).
function edgeTarget(name, value) {
  const v = unquote(value.trim());
  // link:/workspace: point at a workspace importer, which is already a root.
  // file: and URL specs have their own snapshot (`name@file:…`) and children,
  // so the edge is followed.
  if (v === '' || /^(link:|workspace:)/.test(v)) return null;
  // npm: alias — the value is already "realname@version" (a package name never
  // contains ':' or '/' beyond the scope slash, which excludes URL specs).
  if (/^(@[^/:]+\/)?[^@/:(]+@/.test(v)) return stripPeers(v);
  return `${name}@${stripPeers(v)}`;
}

export function lockfileScopes(text) {
  const lines = text.split(/\r?\n/);
  let section = null;
  const roots = { prod: new Set(), dev: new Set() };
  const edges = new Map(); // snapshot id → Set of snapshot ids
  let sawImporters = false;
  let sawSnapshots = false;

  let importerGroup = null; // 'prod' | 'dev' | null
  let depName = null;
  let snapshot = null;
  let snapshotEdges = false;

  for (const raw of lines) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (indent === 0) {
      section = line.replace(/:.*$/, '');
      if (section === 'importers') sawImporters = true;
      if (section === 'snapshots') sawSnapshots = true;
      importerGroup = depName = snapshot = null;
      snapshotEdges = false;
      continue;
    }

    if (section === 'importers') {
      if (indent === 2) {
        importerGroup = depName = null;
      } else if (indent === 4) {
        const key = line.replace(/:$/, '');
        importerGroup = key === 'dependencies' || key === 'optionalDependencies' ? 'prod' : key === 'devDependencies' ? 'dev' : null;
        depName = null;
      } else if (indent === 6 && importerGroup) {
        depName = unquote(line.replace(/:$/, ''));
      } else if (indent === 8 && importerGroup && depName && line.startsWith('version:')) {
        const target = edgeTarget(depName, line.slice('version:'.length));
        if (target) roots[importerGroup].add(target);
      }
    } else if (section === 'snapshots') {
      if (indent === 2) {
        const m = line.match(/^('[^']*'|"[^"]*"|[^\s:][^\s]*?):(\s|$)/);
        snapshot = m ? snapshotId(m[1]) : null;
        snapshotEdges = false;
        if (snapshot && !edges.has(snapshot)) edges.set(snapshot, new Set());
      } else if (indent === 4 && snapshot) {
        snapshotEdges = line === 'dependencies:' || line === 'optionalDependencies:';
      } else if (indent === 6 && snapshot && snapshotEdges) {
        const m = line.match(/^('[^']*'|"[^"]*"|[^\s:]+):\s+(.+)$/);
        if (m) {
          const target = edgeTarget(unquote(m[1]), m[2]);
          if (target) edges.get(snapshot).add(target);
        }
      }
    }
  }

  if (!sawImporters || roots.prod.size + roots.dev.size === 0) throw new Error('lockfile has no importers with dependencies — cannot walk the production closure');
  if (!sawSnapshots || edges.size === 0) throw new Error('lockfile has no snapshots section — cannot walk the production closure');

  // An edge into a key that is not a snapshot (a URL spec the edge parser
  // misread, a lockfile shape change) would silently drop its subtree and could
  // leave a production package scoped dev. Refuse instead.
  const dangling = new Set();
  for (const id of [...roots.prod, ...roots.dev]) if (!edges.has(id)) dangling.add(id);
  for (const targets of edges.values()) for (const id of targets) if (!edges.has(id)) dangling.add(id);
  if (dangling.size > 0) throw new Error(`${dangling.size} dependency edge(s) point at no snapshot (e.g. ${[...dangling][0]}) — cannot trust the production closure`);

  const walk = (start) => {
    const seen = new Set();
    const stack = [...start];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of edges.get(id) ?? []) stack.push(next);
    }
    return seen;
  };

  const scopes = new Map();
  for (const id of walk(roots.dev)) scopes.set(id, 'dev');
  for (const id of walk(roots.prod)) scopes.set(id, 'production'); // production wins
  return scopes;
}

export const scopeOf = (scopes, name, version) => scopes.get(`${name}@${version}`) ?? 'unknown';

// realpath: node resolves symlinks in import.meta.url but not in argv[1] (macOS /var → /private/var).
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const file = process.argv[2];
    if (!file) throw new Error('usage: lockfile-scope.mjs <pnpm-lock.yaml>');
    process.stdout.write(`${JSON.stringify(Object.fromEntries(lockfileScopes(readFileSync(file, 'utf8'))))}\n`);
  } catch (e) {
    process.stderr.write(`lockfile-scope: ${e.message}\n`);
    process.exitCode = 1;
  }
}
