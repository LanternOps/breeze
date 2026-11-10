import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  *" --print-uris "*) phase=uris ;;
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
for arg in "$@"; do
  case "$arg" in
    Dir::Etc::sourcelist=*) cp "\${arg#*=}" "$(dirname "$APT_SCRIPT")/sources-seen" 2>/dev/null ;;
  esac
done
if [ -n "\${TMPDIR_SEEN:-}" ]; then ls "$TMPDIR" >> "$TMPDIR_SEEN"; fi
if [ "$phase" = probe ]; then
  mkdir -p "$archives/partial" "$lists/partial"; touch "$archives/lock" "$lists/lock"
fi
if [ -n "\${RECORD_STATE:-}" ] && [ "$phase" = update ]; then
  ls "$archives" "$lists" > "$(dirname "$APT_SCRIPT")/seen-archives"
fi
code=$(awk -v p="$phase" '$1 == p { print $2; exit }' "$APT_SCRIPT" 2>/dev/null)
code=\${code:-0}
if [ "$phase" = uris ] && [ "$code" = 0 ]; then cat "$SIM_OUTPUT" 2>/dev/null; fi
if [ "$phase" = update ] && [ "$code" = 0 ]; then mkdir -p "$lists"; echo idx > "$lists/ubuntu_Packages"; fi
if [ "$phase" = download ]; then
  seen="$(dirname "$APT_SCRIPT")/archives-at-download"
  if [ ! -e "$seen" ]; then ls "$archives" > "$seen"; fi
  if [ "$code" = 0 ] && [ -n "\${DOWNLOAD_DEBS:-}" ]; then
    mkdir -p "$archives"; for d in $DOWNLOAD_DEBS; do echo deb > "$archives/$d"; done
  fi
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
      root,
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
function runInTmp(runEnv, root, cache, env) {
  const tmp = path.join(root, 'tmp');
  mkdirSync(tmp);
  return runEnv(['ensure', cache], { TMPDIR: tmp, ...env });
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
  assert.deepEqual(phaseNames(), ['probe', 'uris']);
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
  assert.deepEqual(phaseNames(), ['probe', 'uris', 'update', 'install']);
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

test('ensure, install hits its deadline: says so rather than blaming the closure', () => harness(({ files, run }) => {
  seedCache(files.cache);
  const r = run('ensure', files.cache);
  assert.equal(r.status, 1, output(r));
  assert.match(output(r), /::error::.*deadline/);
  assert.doesNotMatch(output(r), /closure incomplete/);
}, { apt: 'cached-install 124\n' }));

test('ensure, network path: a failed index fetch is an error, not a quiet stale install', () => harness(({ files, run }) => {
  assert.equal(run('ensure', files.cache).status, 0);
  const update = readFileSync(files.calls, 'utf8').trim().split('\n').find((l) => / update /.test(` ${l} `));
  assert.match(update, /--error-on=any/);
}));

test('ensure, a probe that times out routes to the network rather than failing the step', () => harness(({ files, run, phaseNames }) => {
  seedCache(files.cache);
  const r = run('ensure', files.cache);
  assert.equal(r.status, 0, output(r));
  assert.deepEqual(phaseNames(), ['probe', 'uris', 'update', 'install']);
  assert.match(output(r), /::warning::.*exit 124/);
}, { apt: 'probe 124\n' }));

test('sources: exactly the three Ubuntu pockets at the fixed mirror, all signature-checked', () => harness(({ files, run }) => {
  assert.equal(run('ensure', files.cache).status, 0);
  const lines = readFileSync(path.join(files.root, 'sources-seen'), 'utf8').trim().split('\n');
  const key = '[signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg]';
  assert.deepEqual(lines, ['resolute', 'resolute-updates', 'resolute-security'].map(
    (suite) => `deb ${key} http://azure.archive.ubuntu.com/ubuntu ${suite} main universe`,
  ));
}));

test('sources: TAURI_APT_MIRROR overrides the mirror', () => harness(({ files, run }) => {
  assert.equal(run('ensure', files.cache).status, 0);
  assert.match(readFileSync(path.join(files.root, 'sources-seen'), 'utf8'), / http:\/\/mirror\.example\/ubuntu resolute main universe/);
}, { env: { TAURI_APT_MIRROR: 'http://mirror.example/ubuntu' } }));

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
      const seen = path.join(root, 'tmp-seen');
      const r = runInTmp(runEnv, root, files.cache, { TMPDIR_SEEN: seen });
      assert.notEqual(readFileSync(seen, 'utf8').trim(), '', 'positive control: temporary state must exist while apt runs');
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

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
// The stub "downloads" files holding this.
const DEB = 'deb\n';
const URIS = (...names) => names.map((n) => `'http://mirror/pool/${n}' ${n} 4 SHA256:${sha256(DEB)}\n`).join('');

test('plan: resolves against an EMPTY dpkg status, so the closure ignores what the image preinstalls', () => harness(({ files, run, phases, phaseNames }) => {
  const r = run('plan', files.work);
  assert.equal(r.status, 0, output(r));
  // Empty status for the image-independent closure, then this image's own plan,
  // which can need more: a preinstalled tool pinned to a library the closure upgrades.
  assert.deepEqual(phaseNames(), ['update', 'uris', 'uris']);
  const status = phases()[1].match(/status=(\S*)/)[1];
  assert.ok(status, 'the download list must set Dir::State::status');
  assert.equal(readFileSync(status, 'utf8'), '', 'status file must be empty');
  assert.equal(phases()[2].match(/status=(\S*)/)[1], '', 'the second list must use the real status');
  assert.match(r.stdout.trim(), /^[0-9a-f]{16}$/, 'stdout is only the closure id');
}, { sim: `${URIS('libbrotli1_1.2_amd64.deb', 'patchelf_0.18_amd64.deb')}Reading package lists...\n` }));

test('plan: the closure id tracks package files and ignores resolver order and apt chatter', () => {
  const id = (sim) => harness(({ files, run }) => run('plan', files.work).stdout.trim(), { sim });
  const a = URIS('a_1_amd64.deb', 'b_2_amd64.deb');
  assert.equal(id(a), id(`Building dependency tree...\n${URIS('b_2_amd64.deb', 'a_1_amd64.deb')}`));
  assert.notEqual(id(a), id(URIS('a_1_amd64.deb', 'b_3_amd64.deb')));
});

test('plan: asks for strong hashes, and a failed index fetch fails the plan', () => harness(({ files, run }) => {
  assert.equal(run('plan', files.work).status, 0);
  const calls = readFileSync(files.calls, 'utf8').trim().split('\n');
  for (const c of calls.filter((l) => l.includes('--print-uris'))) assert.match(c, /Acquire::ForceHash=SHA256/, c);
  // apt-get update exits 0 after failing to fetch a suite unless told otherwise, which
  // would resolve a stale closure and save it under an immutable key.
  assert.match(calls.find((l) => / update /.test(` ${l} `)), /--error-on=any/);
}, { sim: URIS('a_1_amd64.deb') }));

test('plan: a failed download list fails the plan', () => harness(({ files, run }) => {
  assert.notEqual(run('plan', files.work).status, 0);
}, { apt: 'uris 100\n', sim: URIS('a_1_amd64.deb') }));

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
}, { sim: URIS('a_1_amd64.deb', 'b_2_amd64.deb'), env: { DOWNLOAD_DEBS: 'a_1_amd64.deb b_2_amd64.deb', TAURI_APT_SEED_BACKOFF: '0' } }));

// A throttled runner gets tens of kB/s, so later seeds must fetch only what the archive
// changed. But apt accepts a file already in its archives on size alone, so reuse has to
// check the hash itself, or one bad file would persist through every later closure.
test('fetch: reuses debs the plan still names when their hash matches, drops the rest', () => harness(({ files, run }) => {
  assert.equal(run('plan', files.work).status, 0);
  mkdirSync(path.join(files.cache, 'archives'), { recursive: true });
  writeFileSync(path.join(files.cache, 'archives', 'a_1_amd64.deb'), DEB);
  writeFileSync(path.join(files.cache, 'archives', 'b_1_amd64.deb'), 'superseded');
  writeFileSync(path.join(files.cache, 'archives', 'c_1_amd64.deb'), 'bad\n'); // same size as DEB
  const r = run('fetch', files.work, files.cache);
  assert.equal(r.status, 0, output(r));
  assert.deepEqual(readFileSync(path.join(files.cache, '..', 'archives-at-download'), 'utf8').match(/\S+\.deb/g), ['a_1_amd64.deb'], 'apt must be handed the verified deb only');
  assert.deepEqual(readdirSync(path.join(files.cache, 'archives')).sort(), ['a_1_amd64.deb', 'b_2_amd64.deb', 'c_1_amd64.deb']);
  assert.equal(readFileSync(path.join(files.cache, 'archives', 'c_1_amd64.deb'), 'utf8'), DEB, 'the bad file must be replaced');
}, { sim: URIS('a_1_amd64.deb', 'b_2_amd64.deb', 'c_1_amd64.deb'), env: { DOWNLOAD_DEBS: 'b_2_amd64.deb c_1_amd64.deb', TAURI_APT_SEED_BACKOFF: '0' } }));

test('fetch: downloads both plans, the empty-status closure and this image\'s own', () => harness(({ files, run, phases }) => {
  assert.equal(run('plan', files.work).status, 0);
  assert.equal(run('fetch', files.work, files.cache).status, 0);
  const downloads = phases().filter((l) => l.startsWith('download '));
  assert.equal(downloads.length, 2);
  assert.ok(downloads[0].match(/status=(\S+)/));
  assert.ok(downloads[1].match(/status= /), downloads[1]);
}, { sim: URIS('a_1_amd64.deb'), env: { DOWNLOAD_DEBS: 'a_1_amd64.deb', TAURI_APT_SEED_BACKOFF: '0' } }));

test('fetch: a downloaded file that does not match its hash is never published', () => harness(({ files, run }) => {
  assert.equal(run('plan', files.work).status, 0);
  const r = run('fetch', files.work, files.cache);
  assert.notEqual(r.status, 0, output(r));
  assert.equal(existsSync(path.join(files.cache, 'archives')), false);
}, { sim: `'http://mirror/pool/a_1_amd64.deb' a_1_amd64.deb 4 SHA256:${'0'.repeat(64)}\n`, env: { DOWNLOAD_DEBS: 'a_1_amd64.deb', TAURI_APT_SEED_BACKOFF: '0' } }));

test('fetch: a plan without strong hashes is refused, whatever the files hold', () => harness(({ files, run }) => {
  assert.equal(run('plan', files.work).status, 0);
  assert.notEqual(run('fetch', files.work, files.cache).status, 0);
}, { sim: `'http://mirror/pool/a_1_amd64.deb' a_1_amd64.deb 4 MD5Sum:${'0'.repeat(32)}\n`, env: { DOWNLOAD_DEBS: 'a_1_amd64.deb', TAURI_APT_SEED_BACKOFF: '0' } }));

test('fetch: fewer debs than the plan fails, so a partial closure is never saved', () => harness(({ files, run }) => {
  assert.equal(run('plan', files.work).status, 0);
  const r = run('fetch', files.work, files.cache);
  assert.notEqual(r.status, 0, output(r));
  assert.equal(existsSync(path.join(files.cache, 'archives')), false);
}, { sim: URIS('a_1_amd64.deb', 'b_2_amd64.deb'), env: { DOWNLOAD_DEBS: 'a_1_amd64.deb', TAURI_APT_SEED_BACKOFF: '0' } }));

test('probe: reports the offline fit of a cache without installing anything', () => harness(({ files, run, phaseNames }) => {
  seedCache(files.cache);
  const r = run('probe', files.cache);
  assert.equal(r.status, 0, output(r));
  assert.deepEqual(phaseNames(), ['probe']);
}));

// The seed saves this directory as the runner user right after probing it, and
// actions/cache only warns when tar cannot read what root and _apt left behind.
test('probe: leaves nothing of apt\'s own in the cache directory', () => harness(({ files, run }) => {
  seedCache(files.cache);
  assert.equal(run('probe', files.cache).status, 0);
  assert.deepEqual(readdirSync(path.join(files.cache, 'archives')), ['a_1_amd64.deb']);
  assert.deepEqual(readdirSync(path.join(files.cache, 'lists')), ['ubuntu_Packages']);
}));

test('probe, closure lacks something: names what is missing', () => harness(({ files, run, phaseNames }) => {
  seedCache(files.cache);
  const r = run('cached', files.cache);
  assert.equal(r.status, 3, output(r));
  assert.deepEqual(phaseNames(), ['probe', 'uris']);
  assert.match(output(r), /::warning::.*brotli_1\.2_amd64\.deb/);
}, { apt: 'probe 100\n', sim: URIS('brotli_1.2_amd64.deb') }));

test('the package list being empty fails instead of "installing" nothing', () => harness(({ files, run, root }) => {
  seedCache(files.cache);
  const copy = path.join(root, 'scripts');
  mkdirSync(copy);
  writeFileSync(path.join(root, 'tauri-apt-packages.txt'), '# nothing\n');
  writeFileSync(path.join(copy, 'tauri-apt.sh'), readFileSync(SCRIPT));
  const r = spawnSync('bash', [path.join(copy, 'tauri-apt.sh'), 'probe', files.cache], { encoding: 'utf8', env: process.env });
  assert.notEqual(r.status, 0);
  assert.match(output(r), /no packages/);
}));

test('an unknown subcommand fails', () => harness(({ run }) => {
  assert.notEqual(run('nope').status, 0);
}));
