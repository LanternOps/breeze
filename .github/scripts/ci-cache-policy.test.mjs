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

// Swatinem/rust-cache saves in its post step unless told not to.
test('Swatinem/rust-cache is restore-only in ci.yml (save-if: false)', () => {
  const rust = ciSteps.filter((s) => usesOf(s).startsWith('Swatinem/rust-cache@'));
  assert.ok(rust.length >= 2, `expected the rust-check and rust-check-windows caches, saw ${rust.length}`);
  for (const s of rust) {
    assert.match(s, /^\s+save-if:\s*false\s*$/m, `rust-cache without save-if: false:\n${s}`);
  }
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

// ---- Seed workflow (W1 task 1b) -------------------------------------------
// ci.yml only restores; ci-cache-seed.yml on main must save EXACTLY what is
// restored: same key expression, same path. A mismatch means nothing ever
// saves that cache and every run silently cold-starts.

const seedUrl = new URL('../workflows/ci-cache-seed.yml', import.meta.url);
const seedText = () => {
  assert.ok(existsSync(seedUrl), 'ci-cache-seed.yml is missing');
  return read(seedUrl);
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();

// A step's `with:` value: single-line (`key: v`) or block scalar (`path: |`).
function withValue(step, field) {
  const lines = step.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^\\s+${field}:`).test(l));
  if (i < 0) return null;
  const inline = lines[i].replace(new RegExp(`^\\s+${field}:\\s*`), '');
  if (!/^[|>]/.test(inline)) return norm(inline);
  const indent = lines[i].search(/\S/);
  const body = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() !== '' && l.search(/\S/) <= indent) break;
    body.push(l.trim());
  }
  return norm(body.join(' '));
}

const restoresIn = (list) =>
  list.filter((s) => usesOf(s).startsWith('actions/cache/restore@'))
    .map((s) => ({ key: withValue(s, 'key'), path: withValue(s, 'path') }));

test('seed workflow saves every key ci.yml and the composites restore', () => {
  const seed = seedText();
  const saves = steps(seed, 6)
    .filter((s) => usesOf(s).startsWith('actions/cache/save@'))
    .map((s) => ({ key: withValue(s, 'key'), path: withValue(s, 'path') }));
  const wanted = [
    ...restoresIn(ciSteps),
    ...restoresIn(compositeSteps.map((c) => c.step)),
  ];
  assert.ok(wanted.length >= 4, `expected go, pnpm, golangci-lint and tauri restores, saw ${wanted.length}`);
  for (const w of wanted) {
    assert.ok(w.key && w.path, `restore without key/path: ${JSON.stringify(w)}`);
    assert.ok(
      saves.some((s) => s.key === w.key && s.path === w.path),
      `no actions/cache/save in the seed with key ${w.key} and path ${w.path}`,
    );
  }
});

// The Go build cache is only valid for one toolchain, and go.mod carries the
// toolchain pin (`go 1.x.y`), so the key hashes go.mod as well as go.sum —
// identically in the composite restore, the seed's restore and its save.
const GO_KEY = "go-${{ runner.os }}-${{ hashFiles('agent/go.sum', 'agent/go.mod') }}";

test('Go cache key hashes go.sum and go.mod, identically everywhere it is restored or saved', () => {
  const goKeys = [
    ...compositeSteps.filter((c) => c.name === 'restore-go-cache').map((c) => ({ where: 'restore-go-cache', step: c.step })),
    ...steps(seedText(), 6).map((step) => ({ where: 'ci-cache-seed.yml', step })),
  ]
    .filter(({ step }) => /^actions\/cache\/(?:restore|save)@/.test(usesOf(step)))
    .map(({ where, step }) => ({ where, key: withValue(step, 'key') }))
    .filter(({ key }) => key?.startsWith('go-'));
  assert.equal(goKeys.length, 3, `expected composite restore + seed restore + seed save, saw ${JSON.stringify(goKeys)}`);
  for (const { where, key } of goKeys) assert.equal(key, GO_KEY, where);
});

// The seed's Go warm compiles what CI compiles to fill GOCACHE; a compile
// failure there (Windows `go vet` has known unsafeptr findings) must not stop
// the save, or that OS never gets a cache. `go mod download` stays fatal: a
// transient fetch failure should leave the key unsaved for the next run to
// retry rather than save a partial module cache that is then never re-warmed.
const seedStep = (name) => {
  const s = steps(seedText(), 6).find((x) => new RegExp(`^ {6}- name: ${name}$`, 'm').test(x));
  assert.ok(s, `seed has no step ${name}`);
  return s;
};

test('seed warm steps never run go vet', () => {
  for (const s of steps(seedText(), 6)) {
    const code = s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /\bgo vet\b/, s);
  }
});

test('seed Go warm: every compile command is non-fatal; the save still runs only on a miss', () => {
  const warm = seedStep('Warm Go caches');
  const compiles = warm.split('\n').filter((l) => /^\s*(?:CGO_ENABLED=\d+ )?go (?:build|test)\b/.test(l));
  assert.ok(compiles.length >= 5, `expected the build + test-compile commands, saw ${compiles.length}`);
  for (const l of compiles) assert.match(l, /\|\| echo "::warning::/, `fatal under bash -e: ${l.trim()}`);
  assert.match(warm, /^\s+if: steps\.cache\.outputs\.cache-hit != 'true'$/m);
  const save = seedStep('Save Go cache');
  assert.match(save, /^\s+if: steps\.cache\.outputs\.cache-hit != 'true'$/m, 'save only on a cache miss');
});

test('seed workflow exports every buildkit cache scope ci.yml reads', () => {
  const seed = seedText();
  const scopes = [...ci.matchAll(/cache-from:\s*type=gha,scope=(\S+)/g)].map((m) => m[1]);
  assert.ok(scopes.length >= 2, `expected ci-smoke and workspace-runtime scopes, saw ${scopes}`);
  for (const scope of scopes) {
    assert.ok(
      seed.includes(`cache-to: type=gha,mode=max,scope=${scope}`),
      `seed lacks cache-to for scope ${scope}`,
    );
    assert.ok(seed.includes(`cache-from: type=gha,scope=${scope}`), `seed lacks cache-from for ${scope}`);
  }
  assert.match(seed, /push:\s*false/);
});

test('seed workflow triggers, concurrency and pins', () => {
  const seed = seedText();
  for (const t of ['workflow_dispatch:', 'schedule:', 'pnpm-lock.yaml', 'agent/go.sum',
    '.github/tauri-apt-packages.txt', 'docker/**', '.github/actions/**', '.github/workflows/ci-cache-seed.yml']) {
    assert.ok(seed.includes(t), `seed missing trigger ${t}`);
  }
  assert.match(seed, /group: ci-cache-seed\s*\n\s+cancel-in-progress: false/);
  assert.ok(!existsSync(new URL('../workflows/tauri-apt-cache-seed.yml', import.meta.url)),
    'old tauri-apt-cache-seed.yml must be folded in');
  for (const s of steps(seed, 6)) {
    const u = usesOf(s);
    if (u && !u.startsWith('./')) assert.match(u, /@[0-9a-f]{40}$/, `unpinned: ${u}`);
  }
  // setup-go in the seed must not save implicitly either.
  for (const s of steps(seed, 6).filter((x) => usesOf(x).startsWith('actions/setup-go@'))) {
    assert.match(s, /^\s+cache:\s*false\s*$/m);
  }
});

// Every OS that restores a cache in ci.yml must have a seed job on that OS,
// otherwise that OS's entries are never saved and its jobs always cold-start.
function jobBlocks(text) {
  const out = [];
  let cur = null;
  for (const line of text.slice(text.search(/^jobs:\s*$/m)).split('\n')) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) { cur = { name: line.trim().slice(0, -1), lines: [] }; out.push(cur); }
    else if (/^\S/.test(line)) cur = null;
    else if (cur) cur.lines.push(line);
  }
  return out.map((j) => ({ name: j.name, text: j.lines.join('\n') }));
}
const osFamily = (v) => (/windows/.test(v) ? 'windows' : /macos/.test(v) ? 'macos' : /ubuntu/.test(v) ? 'ubuntu' : null);
function jobOses(job) {
  const m = job.text.match(/^ {4}runs-on:\s*(.+)$/m);
  assert.ok(m, `job ${job.name} has no runs-on`);
  const v = m[1].trim();
  const mx = v.match(/matrix\.(\w+)/);
  if (!mx) return [osFamily(v)];
  // Matrix values: `key: value` lines (include entries) or an inline `key: [a, b]` list.
  return [...job.text.matchAll(new RegExp(`^\\s+(?:- )?${mx[1]}:\\s*(.+?)\\s*$`, 'gm'))]
    .flatMap((x) => x[1].replace(/^\[|\]$/g, '').split(',').map((v) => osFamily(v.trim())));
}

test('seed runner OS set covers every OS that restores each cache in ci.yml', () => {
  const seedJobs = jobBlocks(seedText());
  const needs = { go: new Set(), pnpm: new Set(), 'golangci-lint': new Set(), tauri: new Set() };
  for (const job of jobBlocks(ci)) {
    const oses = jobOses(job).filter(Boolean);
    if (/restore-go-cache/.test(job.text)) oses.forEach((o) => needs.go.add(o));
    if (/restore-pnpm-cache/.test(job.text)) oses.forEach((o) => needs.pnpm.add(o));
    if (/golangci-lint-v/.test(job.text)) oses.forEach((o) => needs['golangci-lint'].add(o));
    if (/tauri-apt-cache/.test(job.text)) oses.forEach((o) => needs.tauri.add(o));
  }
  const seedOses = (re) => new Set(seedJobs.filter((j) => re.test(j.text)).flatMap(jobOses).filter(Boolean));
  const have = {
    go: seedOses(/cache\/save[\s\S]*key: go-/),
    pnpm: seedOses(/cache\/save[\s\S]*key: pnpm-/),
    'golangci-lint': seedOses(/cache\/save[\s\S]*key: golangci-lint-/),
    tauri: seedOses(/cache\/save[\s\S]*key: tauri-apt-/),
  };
  for (const [cache, oses] of Object.entries(needs)) {
    assert.ok(oses.size > 0, `found no ci.yml jobs restoring ${cache}`);
    for (const o of oses) {
      assert.ok(have[cache].has(o), `seed has no ${cache} job on ${o}, but ci.yml restores ${cache} there`);
    }
  }
});
