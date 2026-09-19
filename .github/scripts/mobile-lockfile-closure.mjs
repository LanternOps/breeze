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
// Fails CLOSED: any parse problem or a missing importer reports changed=true.
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

/** Reachable package@version snapshot keys from one importer; null if the importer is missing. */
export function mobileClosure(lock, importer = 'apps/mobile') {
  const imp = lock.importers?.[importer];
  if (!imp || typeof imp !== 'object') return null;
  const snapshots = lock.snapshots ?? {};
  const seen = new Set();
  const queue = [];
  const links = new Set();
  for (const group of DEP_GROUPS) {
    for (const [name, spec] of Object.entries(imp[group] ?? {})) {
      const version = typeof spec === 'object' ? spec.version : spec;
      if (typeof version !== 'string') continue;
      if (version.startsWith('link:')) { links.add(`${name}=${version}`); continue; }
      queue.push(`${name}@${version}`);
    }
  }
  while (queue.length) {
    const key = queue.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const snap = snapshots[key];
    if (!snap || typeof snap !== 'object') continue; // unknown key: still counted by name
    for (const group of DEP_GROUPS) {
      for (const [name, version] of Object.entries(snap[group] ?? {})) {
        if (typeof version !== 'string' || version.startsWith('link:')) continue;
        queue.push(`${name}@${version}`);
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
