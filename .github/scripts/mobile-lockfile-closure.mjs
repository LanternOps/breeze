#!/usr/bin/env node
// Decide whether a pnpm-lock.yaml change touches the mobile app's dependency
// closure. `mobile-native-changes` used to fire the 34-minute macOS simulator
// build on ANY lockfile edit, so every api/web dependency bump and every
// lockfile regeneration on the merge queue paid for it. This walks the
// `apps/mobile` importer through `snapshots:` in both lockfile versions and
// reports whether the reachable set of package@version keys differs.
//
// Usage: node mobile-lockfile-closure.mjs <base-lockfile> <head-lockfile> [importer]
// Prints `changed=true|false` and a reason line; exit code is 0 either way.
// Fails CLOSED: any parse problem, unsupported lockfileVersion, missing
// importer, or a reachable key with no snapshots entry reports changed=true.
// (Shell-level failures in the CI step — git fetch/show — fail the JOB, which
// `ci-success` treats as a hard red: louder still, never silent.)
//
// The lockfile is a plain nested map of scalars (v9). Parsing is a deliberate
// indentation-only subset — enough for `importers:` and `snapshots:`; it does
// not need to understand `resolution: {integrity: …}` flow maps beyond
// treating them as opaque scalar values.

import { readFileSync } from 'node:fs';

export function parseLockfile(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    const { key, value } = splitKey(line);
    if (key === null) continue; // list items / continuation lines: not needed
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (value === null) {
      const node = {};
      parent[key] = node;
      stack.push({ indent, node });
    } else if (value === '{}') {
      // Leaf snapshot with no dependencies (`name@1.2.3: {}`) — an empty map,
      // not a scalar, so the closure walk can tell it from a missing entry.
      parent[key] = {};
    } else {
      parent[key] = value;
    }
  }
  return root;
}

function splitKey(line) {
  let key;
  let rest;
  if (line.startsWith("'")) {
    const close = line.indexOf("'", 1);
    if (close === -1 || line[close + 1] !== ':') return { key: null, value: null };
    key = line.slice(1, close);
    rest = line.slice(close + 2);
  } else if (line.startsWith('"')) {
    const close = line.indexOf('"', 1);
    if (close === -1 || line[close + 1] !== ':') return { key: null, value: null };
    key = line.slice(1, close);
    rest = line.slice(close + 2);
  } else {
    const idx = line.indexOf(': ');
    if (idx === -1) {
      if (!line.endsWith(':')) return { key: null, value: null };
      key = line.slice(0, -1);
      rest = '';
    } else {
      key = line.slice(0, idx);
      rest = line.slice(idx + 1);
    }
  }
  const value = rest.trim();
  return { key, value: value === '' ? null : stripQuotes(value) };
}

function stripQuotes(v) {
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) return v.slice(1, -1);
  return v;
}

const DEP_GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/**
 * Snapshot key for a dependency entry. Normally `name@version`, but an
 * aliased dependency (`ip: neoip@3.1.0`, i.e. `npm:neoip@3` in package.json)
 * carries the real package in the value, and its snapshot is keyed by that
 * value alone. A peer suffix `(react@19.1.0)` never precedes the first `@`.
 */
const ALIAS_VERSION = /^@?[^@(]+@/u;
const snapshotKey = (name, version) => (ALIAS_VERSION.test(version) ? version : `${name}@${version}`);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Structural invariants the walk relies on. A lockfile that parses into
 * something else (new pnpm major, wrapper key, restructured groups) must
 * THROW so compareLockfiles reports changed=true — a plausible-looking but
 * wrong closure on both sides would otherwise diff as "identical" and skip
 * the build silently. This is what makes "fails closed" real rather than a
 * comment.
 */
function assertLockfileShape(lock) {
  const version = String(lock.lockfileVersion ?? '');
  if (!version.startsWith('9.')) throw new Error(`unsupported lockfileVersion ${JSON.stringify(lock.lockfileVersion)}; this parser knows v9 only`);
  if (!isPlainObject(lock.importers) || Object.keys(lock.importers).length === 0) throw new Error('importers: block missing or empty');
  if (!isPlainObject(lock.snapshots) || Object.keys(lock.snapshots).length === 0) throw new Error('snapshots: block missing or empty');
}

/** Reachable package@version snapshot keys from one importer; null if the importer is missing. */
export function mobileClosure(lock, importer = 'apps/mobile') {
  assertLockfileShape(lock);
  const imp = lock.importers[importer];
  if (!isPlainObject(imp)) return null;
  const snapshots = lock.snapshots;
  const seen = new Set();
  const queue = [];
  const links = new Set();
  for (const group of DEP_GROUPS) {
    if (imp[group] === undefined) continue;
    if (!isPlainObject(imp[group])) throw new Error(`importer ${importer}.${group} is not a map`);
    for (const [name, spec] of Object.entries(imp[group])) {
      const version = isPlainObject(spec) ? spec.version : spec;
      if (typeof version !== 'string') throw new Error(`importer ${importer}.${group}.${name} has no version string`);
      if (version.startsWith('link:')) { links.add(`${name}=${version}`); continue; }
      queue.push(snapshotKey(name, version));
    }
  }
  while (queue.length) {
    const key = queue.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const snap = snapshots[key];
    // Every resolved, non-link dependency has a snapshot entry in v9. A missing
    // one means a truncated or restructured lockfile: fail closed rather than
    // silently dropping that subtree from the closure.
    if (!isPlainObject(snap)) throw new Error(`no snapshots entry for reachable key ${key}`);
    for (const group of DEP_GROUPS) {
      if (snap[group] === undefined) continue;
      if (!isPlainObject(snap[group])) throw new Error(`snapshot ${key}.${group} is not a map`);
      for (const [name, version] of Object.entries(snap[group])) {
        if (typeof version !== 'string') throw new Error(`snapshot ${key}.${group}.${name} has no version string`);
        if (version.startsWith('link:')) continue;
        queue.push(snapshotKey(name, version));
      }
    }
  }
  return { keys: seen, links };
}

export function compareLockfiles(baseText, headText, importer = 'apps/mobile') {
  let base;
  let head;
  try {
    base = mobileClosure(parseLockfile(baseText), importer);
    head = mobileClosure(parseLockfile(headText), importer);
  } catch (err) {
    return { changed: true, reason: `parse error: ${err?.message ?? err}` };
  }
  if (!base || !head) return { changed: true, reason: `importer ${importer} missing on ${!base ? 'base' : 'head'}` };
  const added = [...head.keys].filter((k) => !base.keys.has(k));
  const removed = [...base.keys].filter((k) => !head.keys.has(k));
  const linkDiff = [...head.links].filter((l) => !base.links.has(l)).concat([...base.links].filter((l) => !head.links.has(l)));
  if (added.length || removed.length || linkDiff.length) {
    return {
      changed: true,
      reason: `mobile closure differs: +${added.length} -${removed.length} links±${linkDiff.length}; e.g. ${(added[0] ?? removed[0] ?? linkDiff[0]).slice(0, 120)}`,
    };
  }
  return { changed: false, reason: `mobile closure identical (${head.keys.size} packages)` };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const [basePath, headPath, importer] = process.argv.slice(2);
  if (!basePath || !headPath) {
    console.log('changed=true');
    console.log('reason=usage: mobile-lockfile-closure.mjs <base-lockfile> <head-lockfile> [importer]');
    process.exit(0);
  }
  let result;
  try {
    result = compareLockfiles(readFileSync(basePath, 'utf8'), readFileSync(headPath, 'utf8'), importer);
  } catch (err) {
    result = { changed: true, reason: `read error: ${err?.message ?? err}` };
  }
  console.log(`changed=${result.changed}`);
  console.log(`reason=${result.reason}`);
}
