import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Behaviour of .github/scripts/tauri-apt.sh against stubbed apt tooling (#9847).
// The real thing was also run against ubuntu:26.04 containers; these pin the
// decisions that are expensive to get wrong in the merge queue: which failure
// takes the network path and which fails the step, and what the seed saves.

const SCRIPT = fileURLToPath(new URL('./tauri-apt.sh', import.meta.url));

// A stub apt-get driven by $APT_SCRIPT: one `<phase> <exit>` per line, where the
// phase is what the call is doing. Every call is recorded to $CALLS.
const APT_STUB = String.raw`#!/bin/bash
printf '%s\n' "$*" >> "$CALLS"
phase=install
case " $* " in
  *" update "*) phase=update ;;
  *" -s "*) phase=simulate ;;
  *" --download-only --no-download "*) phase=probe ;;
  *" --download-only "*) phase=download ;;
  *" --no-download "*) phase=cached-install ;;
esac
archives=""; lists=""; status=""
for arg in "$@"; do
  case "$arg" in
    Dir::Cache::archives=*) archives="\${arg#*=}" ;;
    Dir::State::lists=*) lists="\${arg#*=}" ;;
    Dir::State::status=*) status="\${arg#*=}" ;;
  esac
done
printf '%s status=%s archives=%s\n' "$phase" "$status" "$archives" >> "$PHASES"
if [ -n "\${RECORD_STATE:-}" ] && [ "$phase" = update ]; then
  ls "$archives" "$lists" > "$(dirname "$APT_SCRIPT")/seen-archives"
fi
code=$(awk -v p="$phase" '$1 == p { print $2; exit }' "$APT_SCRIPT" 2>/dev/null)
code=\${code:-0}
if [ "$phase" = simulate ] && [ "$code" = 0 ]; then cat "$SIM_OUTPUT" 2>/dev/null; fi
if [ "$phase" = update ] && [ "$code" = 0 ]; then mkdir -p "$lists"; echo idx > "$lists/ubuntu_Packages"; fi
if [ "$phase" = download ] && [ "$code" = 0 ] && [ -n "\${DOWNLOAD_DEBS:-}" ]; then
  mkdir -p "$archives"; for d in $DOWNLOAD_DEBS; do echo deb > "$archives/$d"; done
fi
exit "$code"
`.replaceAll('\\${', '${');

function harness(fn, { apt = '', sim = '', env = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'tauri-apt-'));
  try {
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const stubs = {
      'apt-get': APT_STUB,
      sudo: '#!/bin/bash\nwhile [[ "$1" == -* ]]; do shift; done\nexec "$@"\n',
      timeout: '#!/bin/bash\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"\n',
      // dpkg must never be invoked directly: apt owns ordering and resolution.
      dpkg: '#!/bin/bash\nif [ "$1" = --print-architecture ]; then echo amd64; exit 0; fi\nprintf "%s\\n" "$*" >> "$DPKG_CALLS"\nexit 0\n',
      chown: '#!/bin/bash\nexit 0\n',
    };
    for (const [name, text] of Object.entries(stubs)) {
      const f = path.join(bin, name);
      writeFileSync(f, text);
      chmodSync(f, 0o755);
    }
    const files = {
      calls: path.join(root, 'calls'),
      phases: path.join(root, 'phases'),
      dpkg: path.join(root, 'dpkg-calls'),
      aptScript: path.join(root, 'apt-script'),
      sim: path.join(root, 'sim'),
      cache: path.join(root, 'cache'),
      work: path.join(root, 'work'),
    };
    writeFileSync(files.calls, '');
    writeFileSync(files.phases, '');
    writeFileSync(files.dpkg, '');
    writeFileSync(files.aptScript, apt);
    writeFileSync(files.sim, sim);
    const run = (args, extraEnv = {}) => spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...extraEnv,
        PATH: `${bin}:${process.env.PATH}`,
        CALLS: files.calls,
        PHASES: files.phases,
        DPKG_CALLS: files.dpkg,
        APT_SCRIPT: files.aptScript,
        SIM_OUTPUT: files.sim,
        TAURI_APT_CODENAME: 'resolute',
        ...env,
      },
    });
    const phases = () => readFileSync(files.phases, 'utf8').trim().split('\n').filter(Boolean);
    const phaseNames = () => phases().map((l) => l.split(' ')[0]);
    return fn({ root, files, run: (...args) => run(args), runEnv: run, phases, phaseNames });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function seedCache(cache) {
  mkdirSync(path.join(cache, 'archives'), { recursive: true });
  mkdirSync(path.join(cache, 'lists'), { recursive: true });
  writeFileSync(path.join(cache, 'archives', 'a_1_amd64.deb'), 'deb');
  writeFileSync(path.join(cache, 'lists', 'ubuntu_Packages'), 'idx');
}

const output = (r) => r.stdout + r.stderr;
function spawnSyncWithTmp(runEnv, root, cache) {
  const tmp = path.join(root, 'tmp');
  mkdirSync(tmp);
  return runEnv(['ensure', cache], { TMPDIR: tmp });
}

test('cached, usable cache: installs through apt offline, never the mirror and never dpkg -i', () => harness(({ files, run, phaseNames }) => {
  seedCache(files.cache);
  const r = run('cached', files.cache);
  assert.equal(r.status, 0, output(r));
  assert.deepEqual(phaseNames(), ['probe', 'cached-install']);
  assert.equal(readFileSync(files.dpkg, 'utf8'), '', 'dpkg must not be invoked directly');
  assert.match(output(r), /installed from cache/);
}));

test('cached, closure does not fit this image: warns and reports unusable, having run no install', () => harness(({ files, run, phaseNames }) => {
  seedCache(files.cache);
  const r = run('cached', files.cache);
  assert.equal(r.status, 3, output(r));
  assert.deepEqual(phaseNames(), ['probe']);
  assert.match(output(r), /::warning::/);
}, { apt: 'probe 100\n' }));

test('cached, install fails after the probe passed: a labelled failure that is NOT reported as unusable', () => harness(({ files, run, phaseNames }) => {
  seedCache(files.cache);
  const r = run('cached', files.cache);
  assert.equal(r.status, 1, output(r));
  assert.deepEqual(phaseNames(), ['probe', 'cached-install']);
  assert.match(output(r), /::error::.*cache closure incomplete.*reseed/);
}, { apt: 'cached-install 100\n' }));

test('cached, nothing restored: reports unusable without calling apt', () => harness(({ files, run, phaseNames }) => {
  const r = run('cached', files.cache);
  assert.equal(r.status, 3, output(r));
  assert.deepEqual(phaseNames(), []);
}));

test('cached, a restored entry from the old flat layout: reports unusable without calling apt', () => harness(({ files, run, phaseNames }) => {
  mkdirSync(files.cache);
  writeFileSync(path.join(files.cache, 'a_1_amd64.deb'), 'deb');
  const r = run('cached', files.cache);
  assert.equal(r.status, 3, output(r));
  assert.deepEqual(phaseNames(), []);
}));

test('cached calls use only the fixed Ubuntu sources, never weaken verification, never remove packages', () => harness(({ files, run }) => {
  seedCache(files.cache);
  assert.equal(run('cached', files.cache).status, 0);
  const calls = readFileSync(files.calls, 'utf8').trim().split('\n');
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.match(c, /Dir::Etc::sourcelist=\S+/, c);
    assert.match(c, /Dir::Etc::sourceparts=-/, c);
    assert.match(c, /--no-install-recommends/, c);
    assert.match(c, /--no-remove/, c);
    assert.doesNotMatch(c, /allow-unauthenticated|trusted=yes|AllowInsecure|Check-Valid-Until=false/, c);
    for (const pkg of ['libwebkit2gtk-4.1-dev', 'libappindicator3-dev', 'librsvg2-dev', 'patchelf']) assert.ok(c.includes(pkg), `${pkg} missing: ${c}`);
  }
}));

test('ensure, usable cache: no mirror traffic at all', () => harness(({ files, run, phaseNames }) => {
  seedCache(files.cache);
  const r = run('ensure', files.cache);
  assert.equal(r.status, 0, output(r));
  assert.deepEqual(phaseNames(), ['probe', 'cached-install']);
}));

test('ensure, closure does not fit this image: takes the network path, reusing the restored debs and indexes', () => harness(({ files, run, phases, phaseNames }) => {
  seedCache(files.cache);
  // Records what the network path was handed when apt ran.
  const r = run('ensure', files.cache);
  assert.equal(r.status, 0, output(r));
  assert.deepEqual(phaseNames(), ['probe', 'update', 'install']);
  assert.match(output(r), /::warning::/);
  const seen = readFileSync(path.join(files.cache, '..', 'seen-archives'), 'utf8');
  assert.match(seen, /a_1_amd64\.deb/, 'only the delta should need the wire');
  assert.match(seen, /ubuntu_Packages/, 'apt-get update should start from the restored indexes');
  assert.notEqual(phases().at(-1).match(/archives=(\S+)/)[1], path.join(files.cache, 'archives'), 'runner.temp may not be traversable by the _apt sandbox user');
}, { apt: 'probe 100\n', env: { RECORD_STATE: '1' } }));

test('ensure, install failed after the probe passed: fails the step with no network attempt', () => harness(({ files, run, phaseNames }) => {
  seedCache(files.cache);
  const r = run('ensure', files.cache);
  assert.equal(r.status, 1, output(r));
  assert.deepEqual(phaseNames(), ['probe', 'cached-install']);
  assert.match(output(r), /::error::.*cache closure incomplete.*reseed/);
}, { apt: 'cached-install 100\n' }));

test('ensure, no cache: goes straight to one network attempt', () => harness(({ files, run, phaseNames }) => {
  const r = run('ensure', files.cache);
  assert.equal(r.status, 0, output(r));
  assert.deepEqual(phaseNames(), ['update', 'install']);
}));

for (const [phase, expected] of [['update', ['update']], ['install', ['update', 'install']]]) {
  test(`ensure, network ${phase} fails: single attempt, labelled error naming the phase`, () => harness(({ files, run, phaseNames }) => {
    const r = run('ensure', files.cache);
    assert.equal(r.status, 1, output(r));
    assert.deepEqual(phaseNames(), expected);
    assert.match(output(r), new RegExp(`::error::.*apt-get ${phase}`));
    assert.match(output(r), /#9847/);
    assert.doesNotMatch(output(r), /deadline/, 'an apt refusal must not be reported as a deadline');
  }, { apt: `${phase} 100\n` }));
}

for (const code of [124, 137]) {
  test(`ensure, phase deadline (exit ${code}): reported as a deadline rather than an apt error`, () => harness(({ files, run }) => {
    const r = run('ensure', files.cache);
    assert.equal(r.status, 1, output(r));
    assert.match(output(r), /::error::.*apt-get update.*deadline/);
  }, { apt: `update ${code}\n` }));
}

test('ensure, network path: fixed sources, verification intact, temporary state removed on both exits', () => {
  for (const apt of ['', 'install 100\n']) {
    harness(({ root, files, runEnv }) => {
      const r = spawnSyncWithTmp(runEnv, root, files.cache);
      const calls = readFileSync(files.calls, 'utf8').trim().split('\n');
      assert.equal(calls.length, 2, output(r));
      for (const c of calls) {
        assert.match(c, /Dir::Etc::sourcelist=\S+/, c);
        assert.match(c, /Dir::Etc::sourceparts=-/, c);
        assert.doesNotMatch(c, /allow-unauthenticated|trusted=yes|AllowInsecure|Check-Valid-Until=false/, c);
      }
      assert.deepEqual(readdirSync(path.join(root, 'tmp')), [], 'temporary apt state must be cleaned');
    }, { apt });
  }
});

test('plan: resolves against an EMPTY dpkg status, so the closure ignores what the image preinstalls', () => harness(({ files, run, phases, phaseNames }) => {
  const r = run('plan', files.work);
  assert.equal(r.status, 0, output(r));
  assert.deepEqual(phaseNames(), ['update', 'simulate']);
  const status = phases()[1].match(/status=(\S*)/)[1];
  assert.ok(status, 'simulate must set Dir::State::status');
  assert.equal(readFileSync(status, 'utf8'), '', 'status file must be empty');
  assert.match(r.stdout.trim(), /^[0-9a-f]{16}$/, 'stdout is only the closure id');
}, { sim: 'Inst libbrotli1 (1.2.0-3ubuntu0.1 Ubuntu:26.04/resolute [amd64])\nInst patchelf (0.18 Ubuntu:26.04/resolute [amd64])\n' }));

test('plan: the closure id tracks package versions and ignores resolver order', () => {
  const id = (sim) => harness(({ files, run }) => run('plan', files.work).stdout.trim(), { sim });
  const a = 'Inst a (1 x [amd64])\nInst b (2 x [amd64])\n';
  assert.equal(id(a), id('Inst b (2 x [amd64])\nInst a (1 x [amd64])\n'));
  assert.notEqual(id(a), id('Inst a (1 x [amd64])\nInst b (3 x [amd64])\n'));
});

test('plan: an empty resolution fails rather than producing a key for nothing', () => harness(({ files, run }) => {
  const r = run('plan', files.work);
  assert.notEqual(r.status, 0, output(r));
}, { sim: '' }));

test('fetch: downloads the empty-status closure and publishes debs + lists into the cache dir', () => harness(({ files, run, phases }) => {
  assert.equal(run('plan', files.work).status, 0);
  mkdirSync(files.cache, { recursive: true });
  writeFileSync(path.join(files.cache, 'stale-from-partial-restore'), 'x');
  const r = run('fetch', files.work, files.cache);
  assert.equal(r.status, 0, output(r));
  const dl = phases().find((l) => l.startsWith('download '));
  assert.ok(dl.match(/status=(\S+)/), 'download must use the empty status');
  assert.deepEqual(readdirSync(path.join(files.cache, 'archives')).sort(), ['a_1_amd64.deb', 'b_2_amd64.deb']);
  assert.ok(existsSync(path.join(files.cache, 'lists', 'ubuntu_Packages')));
  assert.equal(existsSync(path.join(files.cache, 'stale-from-partial-restore')), false, 'a partial restore must not leak into the save');
}, { sim: 'Inst a (1 x [amd64])\nInst b (2 x [amd64])\n', env: { DOWNLOAD_DEBS: 'a_1_amd64.deb b_2_amd64.deb', TAURI_APT_SEED_BACKOFF: '0' } }));

test('fetch: fewer debs than the plan fails, so a partial closure is never saved', () => harness(({ files, run }) => {
  assert.equal(run('plan', files.work).status, 0);
  const r = run('fetch', files.work, files.cache);
  assert.notEqual(r.status, 0, output(r));
  assert.equal(existsSync(path.join(files.cache, 'archives')), false);
}, { sim: 'Inst a (1 x [amd64])\nInst b (2 x [amd64])\n', env: { DOWNLOAD_DEBS: 'a_1_amd64.deb', TAURI_APT_SEED_BACKOFF: '0' } }));

test('probe: reports the offline fit of a cache without installing anything', () => harness(({ files, run, phaseNames }) => {
  seedCache(files.cache);
  const r = run('probe', files.cache);
  assert.equal(r.status, 0, output(r));
  assert.deepEqual(phaseNames(), ['probe']);
}));

test('an unknown subcommand fails', () => harness(({ run }) => {
  assert.notEqual(run('nope').status, 0);
}));
