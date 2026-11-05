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

// The Tauri entry is named by its closure id, passed to the composite and computed
// by the seed's plan step: the same value under two expressions.
const sameClosure = (key) => key?.replace(/\$\{\{ (?:inputs|steps\.plan\.outputs)\.closure \}\}/u, '<closure>');
const restoresIn = (list) =>
  list.filter((s) => usesOf(s).startsWith('actions/cache/restore@'))
    .map((s) => ({ key: sameClosure(withValue(s, 'key')), path: withValue(s, 'path') }));

test('seed workflow saves every key ci.yml and the composites restore', () => {
  const seed = seedText();
  const saves = steps(seed, 6)
    .filter((s) => usesOf(s).startsWith('actions/cache/save@'))
    .map((s) => ({ key: sameClosure(withValue(s, 'key')), path: withValue(s, 'path') }));
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
    '.github/tauri-apt-packages.txt', '.github/scripts/tauri-apt.sh', 'docker/**', '.github/actions/**', '.github/workflows/ci-cache-seed.yml']) {
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

// ---- Tauri apt closure (#9847) ---------------------------------------------
// Cached debs only install on the distro release they were resolved for, and a
// fixed key would freeze the closure while runner images move past it.

test('rust-check and the Tauri seed pin one explicit runner label', () => {
  const label = (text, name) => jobBlocks(text).find((j) => j.name === name)?.text.match(/^ {4}runs-on:\s*(\S+)\s*$/m)?.[1];
  const ciLabel = label(ci, 'rust-check');
  assert.ok(ciLabel, 'rust-check has no runs-on');
  assert.equal(label(seedText(), 'seed-tauri-apt'), ciLabel);
  assert.doesNotMatch(ciLabel, /-latest$/, '-latest moves between distro releases while both are being served');
});

test('the Tauri restore takes the newest closure, and the seed asks for its exact one', () => {
  const composite = composites.find((c) => c.name === 'tauri-apt-cache');
  assert.ok(composite, 'missing tauri-apt-cache composite');
  const restore = steps(composite.text, 4).find((s) => usesOf(s).startsWith('actions/cache/restore@'));
  const prefix = withValue(restore, 'restore-keys');
  assert.ok(prefix?.endsWith('-'), `restore-keys must be a prefix: ${prefix}`);
  assert.equal(withValue(restore, 'key'), `${prefix}\${{ inputs.closure }}`);
  const seed = jobBlocks(seedText()).find((j) => j.name === 'seed-tauri-apt').text;
  assert.match(seed, /uses: \.\/\.github\/actions\/tauri-apt-cache\n\s+with:\n\s+closure: \$\{\{ steps\.plan\.outputs\.closure \}\}/);
});

test('the Tauri seed verifies a closure offline before saving it, and only on a miss', () => {
  const seedSteps = steps(seedText(), 6);
  const at = (re) => seedSteps.findIndex((s) => re.test(s));
  const fetch = at(/tauri-apt\.sh fetch/);
  const probe = at(/tauri-apt\.sh probe/);
  const save = at(/name: Save Tauri apt cache/);
  assert.ok(fetch >= 0 && probe > fetch && save > probe, `fetch ${fetch}, probe ${probe}, save ${save}`);
  for (const i of [fetch, probe, save]) {
    assert.match(seedSteps[i], /^\s+if: steps\.cache\.outputs\.cache-hit != 'true'$/m);
  }
});

// The first seed of a closure downloads all of it through a mirror that throttles
// sustained downloads, and a job killed by its timeout saves nothing.
test('the Tauri seed job outlasts every download attempt the script can make', () => {
  const seedJob = jobBlocks(seedText()).find((j) => j.name === 'seed-tauri-apt').text;
  const jobMinutes = Number(seedJob.match(/^ {4}timeout-minutes:\s*(\d+)\s*$/m)?.[1]);
  const script = read(new URL('./tauri-apt.sh', import.meta.url));
  const attempts = Number(script.match(/attempts=(\d+)/)?.[1]);
  const perAttempt = [...script.matchAll(/timeout --kill-after=30s (\d+)m apt-get install -y --download-only/g)]
    .reduce((sum, m) => sum + Number(m[1]), 0);
  assert.ok(attempts && perAttempt, 'could not read the fetch budget from tauri-apt.sh');
  // Each download can run 30s past its deadline; plan, restore, probe and save get the slack.
  const worst = attempts * (perAttempt + 1) + 10;
  assert.ok(jobMinutes > worst, `job ${jobMinutes}m vs ${worst}m worst case`);
});

// rust-check's step comment promises a labelled failure inside the step, not GitHub's
// generic timeout. Worst path: a closure that does not fit, then one network attempt.
test('the Tauri install phases fit inside rust-check\'s step timeout', () => {
  const step = ciSteps.find((s) => /name: Install Tauri system dependencies/.test(s));
  const stepMinutes = Number(step.match(/^\s+timeout-minutes:\s*(\d+)\s*$/m)?.[1]);
  const script = read(new URL('./tauri-apt.sh', import.meta.url));
  const seconds = (re) => {
    const m = script.match(re);
    assert.ok(m, `no bound matching ${re}`);
    return Number(m[1]) * (m[2] === 'm' ? 60 : 1) + Number(m[3]) * (m[4] === 'm' ? 60 : 1);
  };
  const bound = (text) => new RegExp(`timeout --kill-after=(\\d+)(s) (\\d+)(m|s) apt-get ${text}`);
  const parts = [bound('install -y --download-only --no-download'), bound('update --error-on=any "\\$\\{APT_OPTS'), /timeout --kill-after=(\d+)(s) (\d+)(m) apt-get install -y \\\n\s+--no-install-recommends --no-remove "\$\{APT_OPTS\[@\]\}" "\$\{TAURI_PKGS/];
  const total = parts.reduce((sum, re) => sum + seconds(re), 0);
  assert.ok(total < stepMinutes * 60, `${total}s of phases vs a ${stepMinutes}m step`);
});

// ---- Every other workflow (#10762, #11119) ---------------------------------
// The same rule as ci.yml, for all of them: an entry saved from a PR ref is
// readable by that PR alone and still counts toward the 10 GB limit, and a
// built-in setup-* cache saved on main only duplicates what the seed saves.
//
// release.yml is the deliberate exception: it runs on tags only, and it builds
// signed artifacts, so its caching is out of bounds for a cache-budget change.
const SAVERS = new Set(['ci-cache-seed.yml', 'release.yml']);
const WORKFLOWS_DIR = new URL('../workflows/', import.meta.url);
const workflows = readdirSync(WORKFLOWS_DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((name) => ({ name, text: read(new URL(name, WORKFLOWS_DIR)) }));
const triggers = (text) => text.slice(0, text.search(/^jobs:\s*$/m));
const runsOnPrRefs = (text) => /^ {2}(?:pull_request|pull_request_target|merge_group):/m.test(triggers(text));

function cacheViolations(text) {
  const out = [];
  for (const s of steps(text, 6)) {
    const uses = usesOf(s);
    if (uses.startsWith('actions/setup-go@') && !/^\s+cache:\s*false\s*$/m.test(s)) out.push(`setup-go without cache: false:\n${s}`);
    if (uses.startsWith('actions/setup-node@') && /^\s+cache:/m.test(s)) out.push(`setup-node with a cache input:\n${s}`);
    if (uses.startsWith('actions/cache') && !uses.startsWith('actions/cache/restore@')) out.push(`${uses} saves a cache`);
    if (uses.startsWith('Swatinem/rust-cache@') && !/^\s+save-if:\s*false\s*$/m.test(s)) out.push(`rust-cache without save-if: false:\n${s}`);
    if (uses.startsWith('aquasecurity/trivy-action@') && !/^\s+cache:\s*'false'\s*$/m.test(s)) out.push(`trivy-action without cache: 'false' (its default saves the DB and the binary):\n${s}`);
    if (/^\s+cache-to:.*type=gha/m.test(s)) out.push(`buildkit exports to gha:\n${s}`);
  }
  return out;
}

test('the PR-ref inventory found the workflows it is meant to police', () => {
  const pr = workflows.filter((w) => runsOnPrRefs(w.text)).map((w) => w.name);
  for (const name of ['ci.yml', 'security.yml', 'codeql.yml', 'yara-pack.yml', 'release-build-check.yml',
    'ci-smoke-binary-source-github.yml', 'ci-smoke-binary-source-local.yml']) {
    assert.ok(pr.includes(name), `${name} not detected as running on PR refs; saw ${pr}`);
  }
  for (const name of SAVERS) assert.ok(!pr.includes(name), `${name} may save caches only because it never runs on a PR ref`);
});

for (const { name, text } of workflows.filter((w) => !SAVERS.has(w.name))) {
  test(`${name} saves no Actions cache`, () => {
    assert.deepEqual(cacheViolations(text), []);
  });
}

// Dropping a built-in cache must not quietly leave the job cold: the restore has
// to be there, after the setup step whose tool it asks for the cache dirs, and
// gated the same way (codeql sets up Go on one matrix leg only).
const RESTORES = {
  'security.yml': ['restore-pnpm-cache', 'restore-go-cache', 'restore-trivy-db'],
  'codeql.yml': ['restore-go-cache'],
  'yara-pack.yml': ['restore-go-cache'],
  'ci-smoke-binary-source-github.yml': ['restore-pnpm-cache'],
  'ci-smoke-binary-source-local.yml': ['restore-pnpm-cache'],
  // Main-only (schedule / dispatch): their built-in caches duplicated the seed's
  // pnpm-* and go-* entries on main (node-cache-*, setup-go-*; #11119).
  'perf.yml': ['restore-pnpm-cache', 'restore-go-cache'],
  'ai-tool-eval.yml': ['restore-pnpm-cache'],
  'workspace-nightly.yml': ['restore-pnpm-cache'],
};
const SETUP_FOR = { 'restore-pnpm-cache': 'pnpm/action-setup@', 'restore-go-cache': 'actions/setup-go@' };
const gateOf = (step) => step.match(/^\s+if:\s*(.+)$/m)?.[1] ?? null;

for (const [name, wanted] of Object.entries(RESTORES)) {
  test(`${name} restores what it no longer saves`, () => {
    const { text } = workflows.find((w) => w.name === name);
    for (const composite of wanted) {
      assert.match(text, new RegExp(`uses: \\./\\.github/actions/${composite}\\b`), `${name} does not use ${composite}`);
    }
    for (const job of jobBlocks(text)) {
      const jobSteps = steps(job.text, 6);
      jobSteps.forEach((s, i) => {
        const composite = usesOf(s).match(/^\.\/\.github\/actions\/(restore-[a-z-]+)$/)?.[1];
        const setup = SETUP_FOR[composite];
        if (!setup) return;
        const at = jobSteps.findIndex((x) => usesOf(x).startsWith(setup));
        assert.ok(at >= 0 && at < i, `${name}/${job.name}: ${composite} runs before ${setup}`);
        if (setup === 'actions/setup-go@') {
          assert.equal(gateOf(s), gateOf(jobSteps[at]), `${name}/${job.name}: ${composite} and setup-go differ in if:`);
        }
      });
    }
  });
}

test('every trivy-action step in security.yml runs after the DB restore', () => {
  const { text } = workflows.find((w) => w.name === 'security.yml');
  let seen = 0;
  for (const job of jobBlocks(text)) {
    const jobSteps = steps(job.text, 6);
    const first = jobSteps.findIndex((s) => usesOf(s).startsWith('aquasecurity/trivy-action@'));
    if (first < 0) continue;
    seen += 1;
    const restore = jobSteps.findIndex((s) => usesOf(s) === './.github/actions/restore-trivy-db');
    assert.ok(restore >= 0 && restore < first, `${job.name}: restore at ${restore}, first trivy step at ${first}`);
  }
  assert.equal(seen, 2, 'expected trivy-fs-scan and trivy-image-scan');
});

test('the seed saves the Trivy DB under the key and path the composite restores, and only on a miss', () => {
  const save = seedStep('Save Trivy DB cache');
  const composite = composites.find((c) => c.name === 'restore-trivy-db');
  assert.ok(composite, 'missing restore-trivy-db composite');
  const restore = steps(composite.text, 4).find((s) => usesOf(s).startsWith('actions/cache/restore@'));
  assert.equal(withValue(save, 'key'), withValue(restore, 'key'));
  assert.equal(withValue(save, 'path'), withValue(restore, 'path'));
  assert.equal(withValue(restore, 'restore-keys'), 'cache-trivy-');
  assert.match(save, /^\s+if: steps\.cache\.outputs\.cache-hit != 'true'$/m);
  const job = jobBlocks(seedText()).find((j) => j.name === 'seed-trivy-db');
  assert.ok(job, 'missing seed-trivy-db job');
  const download = steps(job.text, 6).find((s) => usesOf(s).startsWith('aquasecurity/trivy-action@'));
  assert.ok(download, 'seed-trivy-db has no trivy-action step');
  assert.match(download, /^\s+cache:\s*'false'\s*$/m, 'the seed must not also save through the action');
});

// ---- Superseded seed keys (#11119) ------------------------------------------
// Keys are immutable, so a lockfile or go.sum change makes a second entry per OS
// (pnpm-Linux 633 + 635 MB, go-* 1.3 + 1.2 GB side by side). Only the newest is
// ever restored by its exact key; the seed deletes the rest of its family.
const loadPrune = () => import('./ci-cache-prune.mjs');
const entry = (key, extra = {}) => ({ id: key.length, key, ref: 'refs/heads/main', sizeInBytes: 100, lastAccessedAt: '2026-11-05T00:00:00Z', ...extra });

test('planSuperseded deletes every other key of the family, never the kept one or another family', async () => {
  const { planSuperseded } = await loadPrune();
  const entries = [entry('pnpm-Linux-new'), entry('pnpm-Linux-old'), entry('pnpm-macOS-x'), entry('pnpm-Linux-older'), entry('golangci-lint-v2-Linux')];
  const { deletions, warning } = planSuperseded(entries, { prefix: 'pnpm-Linux-', keep: 'pnpm-Linux-new' });
  assert.equal(warning, null);
  assert.deepEqual(deletions.map((e) => e.key).sort(), ['pnpm-Linux-old', 'pnpm-Linux-older']);
});

test('planSuperseded deletes nothing when the kept key is not listed (a failed or lagging save)', async () => {
  const { planSuperseded } = await loadPrune();
  const { deletions, warning } = planSuperseded([entry('go-Linux-old')], { prefix: 'go-Linux-', keep: 'go-Linux-new' });
  assert.deepEqual(deletions, []);
  assert.match(warning, /go-Linux-new/);
});

test('planSuperseded refuses a keep key outside its own prefix', async () => {
  const { planSuperseded } = await loadPrune();
  assert.throws(() => planSuperseded([], { prefix: 'go-Linux-', keep: 'pnpm-Linux-x' }), /prefix/);
});

// The prune job recomputes each key the seed jobs saved. If its hash or OS list
// drifts from theirs it keeps the wrong key: with the "keep not listed" guard
// that deletes nothing, but it also prunes nothing, silently.
const seedJob = (name) => jobBlocks(seedText()).find((j) => j.name === name);
const runnerOs = { 'ubuntu-latest': 'Linux', 'macos-latest': 'macOS', 'windows-latest': 'Windows' };
const matrixOses = (name) => seedJob(name).text.match(/^\s+os:\s*\[(.+)\]\s*$/m)[1].split(',').map((s) => runnerOs[s.trim()]);

test('the prune job recomputes exactly the keys the pnpm, Go and Trivy seeds save, for every OS they run on', () => {
  const prune = steps(seedJob('enforce-cache-budget').text, 6).find((s) => /name: Prune superseded seed keys$/m.test(s));
  assert.ok(prune, 'missing Prune superseded seed keys step');
  const families = [
    { job: 'seed-pnpm', save: 'Save pnpm cache', prefix: 'pnpm-', env: 'PNPM_HASH' },
    { job: 'seed-go', save: 'Save Go cache', prefix: 'go-', env: 'GO_HASH' },
  ];
  for (const { job, save, prefix, env } of families) {
    const key = withValue(steps(seedJob(job).text, 6).find((s) => new RegExp(`name: ${save}$`, 'm').test(s)), 'key');
    assert.equal(`${prefix}\${{ runner.os }}-${withValue(prune, env)}`, key, `${env} vs the ${job} save key`);
    const loop = prune.match(new RegExp(`for os in ([A-Za-z ]+); do prune "${prefix}\\$\\{os\\}-" "\\$\\{${env}\\}"; done`));
    assert.ok(loop, `no prune loop for ${prefix}`);
    assert.deepEqual(loop[1].trim().split(/\s+/).sort(), matrixOses(job).sort(), `${prefix} OS list vs the ${job} matrix`);
  }
  const date = composites.find((c) => c.name === 'restore-trivy-db').text.match(/date=\$\((date [^)]+)\)/)[1];
  assert.ok(prune.includes(`prune cache-trivy- "$(${date})"`), `Trivy key must use the composite's ${date}`);
  assert.doesNotMatch(prune, /continue-on-error/);
  assert.match(prune, /\|\| echo "::warning::/, 'a failed prune warns and moves on; it only costs space');
});

// Seed jobs run pnpm install (dependency lifecycle scripts), go builds and trivy.
// A token that can delete caches or dispatch workflows stays out of them.
test('no seed job that installs, builds or scans holds actions: write', () => {
  for (const job of jobBlocks(seedText())) {
    const writes = /^ {6}actions: write\b/m.test(job.text);
    // seed-tauri-apt prunes its own closures (#11015) and runs apt downloads only.
    if (job.name === 'enforce-cache-budget' || job.name === 'seed-tauri-apt') continue;
    assert.ok(!writes, `${job.name} holds actions: write`);
  }
  const budget = steps(seedJob('enforce-cache-budget').text, 6);
  for (const s of budget) {
    const uses = usesOf(s);
    assert.ok(!uses || uses.startsWith('actions/checkout@'), `enforce-cache-budget runs ${uses}`);
    const code = s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /\b(?:pnpm (?:install|i)|go (?:build|test|mod|install|run)|npm (?:ci|install)|trivy (?:fs|image))\b/,
      `enforce-cache-budget step runs more than the prune script:\n${s}`);
  }
});

test('the pnpm seed starts a new lockfile from an empty store, so the saved store is that lockfile only', () => {
  const restore = seedStep('Restore pnpm cache');
  assert.equal(withValue(restore, 'restore-keys'), null);
});

test('the Go seed drops the restored module cache before downloading a new go.sum', () => {
  const warm = seedStep('Warm Go caches');
  const clean = warm.search(/^\s+go clean -modcache$/m);
  const download = warm.search(/go mod download/);
  assert.ok(clean >= 0 && clean < download, 'go clean -modcache must run before go mod download');
});

// ---- Seed resilience (#11119) ------------------------------------------------
// The Tauri closure was restored at 05:39 (a hit, so nothing was saved) and gone
// by 09:36: at the 10 GB limit GitHub evicts least-recently-used entries of any
// kind, and the seed's own buildkit exports (~1 GB a run) were the churn.
const DAILY = '17 5 * * *';
const SIX_HOURLY = '17 11,17,23 * * *';
const WEEKLY = '37 5 * * 1';
const jobIf = (name) => {
  const job = jobBlocks(seedText()).find((j) => j.name === name);
  assert.ok(job, `missing seed job ${name}`);
  return job.text.match(/^ {4}if:\s*(.+?)\s*$/m)?.[1] ?? null;
};

test('seed schedules: daily for everything, six-hourly for the Tauri closure, weekly for image layers', () => {
  const crons = [...triggers(seedText()).matchAll(/^\s+- cron: '([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(crons.sort(), [DAILY, SIX_HOURLY, WEEKLY].sort());
  // The six-hourly hours must not include the daily one, or that slot runs twice.
  assert.ok(!SIX_HOURLY.split(' ')[1].split(',').includes(DAILY.split(' ')[1]));
});

test('only the Tauri and Trivy seeds run on the six-hourly schedule', () => {
  for (const name of ['seed-tauri-apt', 'seed-trivy-db']) assert.equal(jobIf(name), null, `${name} is gated`);
  for (const name of ['seed-pnpm', 'seed-go', 'seed-golangci-lint']) {
    assert.equal(jobIf(name), `github.event.schedule != '${SIX_HOURLY}'`, name);
  }
});

// Each image seed run exports about 1 GB of new layers (`COPY . .` changes on
// every commit), so a daily rebuild churned the cache for layers PRs never hit.
// The layers PRs do reuse (deps, base images) change with the paths that already
// trigger the seed on push.
test('image layer seeds run on push, dispatch and the weekly schedule only', () => {
  for (const name of ['seed-smoke-images', 'seed-workspace-runtime']) {
    assert.equal(jobIf(name), `github.event_name != 'schedule' || github.event.schedule == '${WEEKLY}'`, name);
  }
});

test('a Tauri hit re-checks its entry on the way out and saves it again if it is gone', () => {
  const job = jobBlocks(seedText()).find((j) => j.name === 'seed-tauri-apt');
  const jobSteps = steps(job.text, 6);
  const at = (re) => jobSteps.findIndex((s) => re.test(s));
  const save = jobSteps[at(/name: Save Tauri apt cache$/m)];
  const recheckAt = at(/name: Check the Tauri apt entry survived$/m);
  const resaveAt = at(/name: Re-save Tauri apt cache$/m);
  assert.equal(recheckAt, jobSteps.length - 2, 'the re-check must be the last thing before the re-save');
  assert.equal(resaveAt, jobSteps.length - 1);
  const recheck = jobSteps[recheckAt];
  const resave = jobSteps[resaveAt];
  assert.match(recheck, /^\s+id: recheck$/m);
  assert.match(recheck, /^\s+if: steps\.cache\.outputs\.cache-hit == 'true'$/m);
  assert.equal(sameClosure(withValue(recheck, 'KEY')), sameClosure(withValue(save, 'key')));
  // Listing failures count as "gone": saving a key that still exists is a no-op.
  assert.match(recheck, /missing=true/);
  // A run restores from its own ref or from main; an entry on either survived.
  // (Seen on a branch dispatch: a branch-only listing re-saved main's closure.)
  assert.doesNotMatch(recheck, /--ref/);
  assert.match(recheck, /\.ref == env\.GITHUB_REF or \.ref == "refs\/heads\/main"/);
  assert.doesNotMatch(recheck, /continue-on-error/);
  assert.match(resave, /^\s+if: steps\.recheck\.outputs\.missing == 'true'$/m);
  assert.ok(usesOf(resave).startsWith('actions/cache/save@'));
  assert.equal(withValue(resave, 'key'), withValue(save, 'key'));
  assert.equal(withValue(resave, 'path'), withValue(save, 'path'));
});

// ---- Cache budget (#11119) ---------------------------------------------------
const GB = 1e9;
const at = (h) => new Date(Date.UTC(2026, 10, 5, h)).toISOString();

test('planBudget always deletes retired families, on any ref', async () => {
  const { planBudget, RETIRED_PREFIXES } = await loadPrune();
  assert.deepEqual([...RETIRED_PREFIXES].sort(), ['node-cache-', 'setup-go-', 'trivy-binary-']);
  const entries = [
    entry('node-cache-Linux-x64-pnpm-a', { sizeInBytes: 0.6 * GB }),
    entry('setup-go-Windows-x64-go-1.26.10-b', { sizeInBytes: 0.2 * GB, ref: 'refs/pull/1/merge' }),
    entry('trivy-binary-v0.70.0-Linux-X64', { sizeInBytes: 0.04 * GB }),
    entry('go-Linux-c', { sizeInBytes: 1.3 * GB }),
  ];
  const { deletions, remaining, overBudget } = planBudget(entries, { budgetBytes: 8.5 * GB, mainRef: 'refs/heads/main' });
  assert.deepEqual(deletions.map((e) => e.key).sort(), entries.slice(0, 3).map((e) => e.key).sort());
  assert.equal(remaining, 1.3 * GB);
  assert.equal(overBudget, false);
});

test('planBudget evicts other refs first, then main buildkit blobs oldest-first, and stops at the budget', async () => {
  const { planBudget } = await loadPrune();
  const entries = [
    entry('go-Linux-a', { sizeInBytes: 4 * GB, lastAccessedAt: at(0) }),
    entry('tauri-apt-ubuntu26-x-y', { sizeInBytes: 0.2 * GB, lastAccessedAt: at(0) }),
    entry('buildkit-blob-1-sha256:new', { sizeInBytes: 2 * GB, lastAccessedAt: at(9) }),
    entry('buildkit-blob-1-sha256:old', { sizeInBytes: 1 * GB, lastAccessedAt: at(1) }),
    entry('buildkit-blob-1-sha256:mid', { sizeInBytes: 1 * GB, lastAccessedAt: at(5) }),
    entry('pnpm-Linux-pr', { sizeInBytes: 0.5 * GB, lastAccessedAt: at(10), ref: 'refs/pull/7/merge' }),
    entry('buildkit-blob-1-sha256:tag', { sizeInBytes: 0.5 * GB, lastAccessedAt: at(11), ref: 'refs/tags/v1.0.0' }),
  ];
  // 9.2 GB total; 8.5 budget: the two non-main entries (1 GB) are enough.
  let plan = planBudget(entries, { budgetBytes: 8.5 * GB, mainRef: 'refs/heads/main' });
  assert.deepEqual(plan.deletions.map((e) => e.key).sort(), ['buildkit-blob-1-sha256:tag', 'pnpm-Linux-pr']);
  // 6.5 budget: then main blobs, oldest access first, until under it.
  plan = planBudget(entries, { budgetBytes: 6.5 * GB, mainRef: 'refs/heads/main' });
  assert.deepEqual(plan.deletions.map((e) => e.key),
    ['pnpm-Linux-pr', 'buildkit-blob-1-sha256:tag', 'buildkit-blob-1-sha256:old', 'buildkit-blob-1-sha256:mid']);
  assert.ok(Math.abs(plan.remaining - 6.2 * GB) < 1);
  assert.equal(plan.overBudget, false);
});

test('planBudget never evicts a main entry that is not a buildkit blob, and says when the budget cannot be met', async () => {
  const { planBudget } = await loadPrune();
  const entries = [
    entry('go-Linux-a', { sizeInBytes: 6 * GB }),
    entry('tauri-apt-ubuntu26-x-y', { sizeInBytes: 0.2 * GB }),
    entry('buildkit-blob-1-sha256:a', { sizeInBytes: 1 * GB }),
  ];
  const plan = planBudget(entries, { budgetBytes: 5 * GB, mainRef: 'refs/heads/main' });
  assert.deepEqual(plan.deletions.map((e) => e.key), ['buildkit-blob-1-sha256:a']);
  assert.equal(plan.overBudget, true);
});

test('planBudget is a no-op under budget', async () => {
  const { planBudget } = await loadPrune();
  const plan = planBudget([entry('buildkit-blob-1-sha256:a', { sizeInBytes: 1 * GB })], { budgetBytes: 8.5 * GB, mainRef: 'refs/heads/main' });
  assert.deepEqual(plan.deletions, []);
});

test('the seed enforces the budget last, on main only, and a failure shows', async () => {
  const { BUDGET_BYTES } = await loadPrune();
  assert.equal(BUDGET_BYTES, 8.5 * GB, 'docs/agents/testing.md documents 8.5 GB (1.5 GB under the limit)');
  const doc = read(new URL('../../docs/agents/testing.md', import.meta.url));
  assert.match(doc, new RegExp(`total under \\*\\*${BUDGET_BYTES / GB} GB\\*\\*`), 'testing.md must state the budget the script enforces');
  const jobs = jobBlocks(seedText());
  const budget = jobs.find((j) => j.name === 'enforce-cache-budget');
  assert.ok(budget, 'missing enforce-cache-budget job');
  const needs = budget.text.match(/^ {4}needs:\s*\[(.+)\]\s*$/m)?.[1].split(',').map((s) => s.trim()).sort();
  assert.deepEqual(needs, jobs.map((j) => j.name).filter((n) => n !== 'enforce-cache-budget').sort());
  assert.match(budget.text, /^ {4}if: \$\{\{ !cancelled\(\) && github\.ref == 'refs\/heads\/main' \}\}$/m);
  assert.match(budget.text, /^ {4}permissions:\n {6}contents: read\n {6}actions: write\b/m);
  assert.match(budget.text, /node \.github\/scripts\/ci-cache-prune\.mjs budget$/m);
  assert.doesNotMatch(budget.text, /continue-on-error/);
});
