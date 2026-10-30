import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { test } from 'node:test';

// Cache hygiene (W1, #10744). Actions caches saved from pull_request and
// merge_group refs can never be restored by any other ref, and they evict
// main's useful caches (the repo sat at 15.7 GB against a 10 GB limit). So
// ci.yml and the composites it uses only RESTORE caches; the seed workflow
// running on main is the only place that saves them.

const ACTIONS_DIR = new URL('../actions/', import.meta.url);
const read = (url) => readFileSync(url, 'utf8');

// Split a YAML file into step chunks. A step starts at a `- ` line at the
// given indent (6 for workflow jobs, 4 for composite actions); this avoids
// needing a YAML parser (none is installed for the .github/scripts tests).
function steps(text, indent) {
  const start = new RegExp(`^ {${indent}}- `);
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (start.test(line)) {
      cur = [line];
      out.push(cur);
    } else if (cur && (line.trim() === '' || /^ {0,}\S/.test(line) && line.search(/\S/) > indent)) {
      cur.push(line);
    } else {
      cur = null;
    }
  }
  return out.map((l) => l.join('\n'));
}

const ci = read(new URL('../workflows/ci.yml', import.meta.url));
const ciSteps = steps(ci, 6);
const composites = readdirSync(ACTIONS_DIR)
  .filter((d) => existsSync(new URL(`${d}/action.yml`, ACTIONS_DIR)))
  .map((d) => ({ name: d, text: read(new URL(`${d}/action.yml`, ACTIONS_DIR)) }));
const compositeSteps = composites.flatMap((c) => steps(c.text, 4).map((s) => ({ name: c.name, step: s })));

const usesOf = (step) => (step.match(/^\s*(?:- )?uses:\s*(\S+)/m) || [])[1] ?? '';

test('setup-go never saves a cache in ci.yml', () => {
  const goSteps = ciSteps.filter((s) => usesOf(s).startsWith('actions/setup-go@'));
  assert.ok(goSteps.length >= 9, `expected >= 9 setup-go steps, saw ${goSteps.length}`);
  for (const s of goSteps) {
    assert.match(s, /^\s+cache:\s*false\s*$/m, `setup-go without cache: false:\n${s}`);
  }
});

test('setup-node never saves a cache in ci.yml', () => {
  const nodeSteps = ciSteps.filter((s) => usesOf(s).startsWith('actions/setup-node@'));
  assert.ok(nodeSteps.length >= 30, `expected >= 30 setup-node steps, saw ${nodeSteps.length}`);
  for (const s of nodeSteps) {
    assert.doesNotMatch(s, /^\s+cache:/m, `setup-node with a cache input:\n${s}`);
  }
});

test('caches are restore-only in ci.yml and its composites', () => {
  const all = [
    ...ciSteps.map((step) => ({ name: 'ci.yml', step })),
    ...compositeSteps,
  ];
  let seen = 0;
  for (const { name, step } of all) {
    const uses = usesOf(step);
    if (uses.startsWith('actions/cache')) {
      seen += 1;
      assert.ok(uses.startsWith('actions/cache/restore@'), `${name}: ${uses} must be actions/cache/restore`);
    }
  }
  assert.ok(seen >= 3, `expected the golangci-lint, tauri and composite restores, saw ${seen}`);
});

test('buildkit never exports to gha from ci.yml', () => {
  for (const s of ciSteps) {
    const m = s.match(/^\s+cache-to:.*$/m);
    if (m) assert.doesNotMatch(m[0], /type=gha/, `cache-to type=gha in:\n${s}`);
  }
});

test('restore composites exist and use only actions/cache/restore', () => {
  for (const name of ['restore-go-cache', 'restore-pnpm-cache']) {
    const c = composites.find((x) => x.name === name);
    assert.ok(c, `missing composite ${name}`);
    assert.match(c.text, /uses: actions\/cache\/restore@[0-9a-f]{40} # v/);
  }
});
