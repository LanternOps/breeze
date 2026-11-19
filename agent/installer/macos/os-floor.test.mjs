import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OS_FLOOR = join(here, 'os-floor.sh');
const PREINSTALL = join(here, 'preinstall');
const BUILD_PKG = join(here, 'build-pkg.sh');

function check(current, minimum) {
  const r = spawnSync(
    'bash',
    ['-c', 'source "$1"; breeze_os_floor_check "$2" "$3"; echo $?', 'bash', OS_FLOOR, current, minimum],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
  return Number(r.stdout.trim().split('\n').pop());
}

test('12.7.6 vs 13.0 refuses', () => assert.equal(check('12.7.6', '13.0'), 1));
test('13.0 vs 13.0 allows', () => assert.equal(check('13.0', '13.0'), 0));
test('13 vs 13.0.0 allows', () => assert.equal(check('13', '13.0.0'), 0));
test('15.8.1 vs 13.0 allows', () => assert.equal(check('15.8.1', '13.0'), 0));
test('empty current is unknown', () => assert.equal(check('', '13.0'), 2));
test('empty minimum is unknown', () => assert.equal(check('15.0', ''), 2));
test('10.16 (SYSTEM_VERSION_COMPAT) is unknown', () => assert.equal(check('10.16', '13.0'), 2));
test('malformed floor is unknown', () => assert.equal(check('15.0', '12.x'), 2));
test('unrendered placeholder is unknown', () => assert.equal(check('15.0', '__BREEZE_MIN_MACOS__'), 2));
test('malformed current is unknown', () => assert.equal(check('darwin 15.0', '13.0'), 2));

test('floor check precedes every launchctl call in preinstall', () => {
  const lines = readFileSync(PREINSTALL, 'utf8').split('\n');
  const code = (re) => lines.findIndex((l) => !/^\s*#/.test(l) && re.test(l));
  const floor = code(/\bbreeze_os_floor_check\b/);
  const firstLaunchctl = code(/\blaunchctl\b/);
  assert.notEqual(floor, -1, 'preinstall does not call breeze_os_floor_check');
  assert.notEqual(firstLaunchctl, -1, 'preinstall has no launchctl call');
  assert.ok(floor < firstLaunchctl, `floor check (line ${floor + 1}) must precede launchctl (line ${firstLaunchctl + 1})`);
});

test('build-pkg.sh rejects a malformed floor before doing any work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-'));
  const bins = ['agent', 'helper', 'backup', 'watchdog'].map((n) => {
    const p = join(dir, n);
    writeFileSync(p, 'x');
    return p;
  });
  const out = join(dir, 'out.pkg');
  const r = spawnSync('bash', [BUILD_PKG, ...bins, '1.0.0', 'arm64', out, '12.x'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /min-macos/i);
  assert.equal(existsSync(out), false);
  assert.doesNotMatch(r.stdout, /Building Breeze Agent/);
});

test('build-pkg.sh requires the min-macos argument', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-'));
  const bins = ['agent', 'helper', 'backup', 'watchdog'].map((n) => {
    const p = join(dir, n);
    writeFileSync(p, 'x');
    return p;
  });
  const r = spawnSync('bash', [BUILD_PKG, ...bins, '1.0.0', 'arm64', join(dir, 'out.pkg')], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /min-macos/i);
});

// End-to-end: run preinstall as the installer would (rendered, next to
// os-floor.sh) with fake sw_vers and launchctl on a controlled PATH.
function runPreinstall({ floor, swVers, withOsFloor = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'pre-'));
  const body = readFileSync(PREINSTALL, 'utf8').replaceAll('__BREEZE_MIN_MACOS__', floor);
  writeFileSync(join(dir, 'preinstall'), body);
  chmodSync(join(dir, 'preinstall'), 0o755);
  if (withOsFloor) copyFileSync(OS_FLOOR, join(dir, 'os-floor.sh'));
  const bin = join(dir, 'bin');
  const log = join(dir, 'launchctl.log');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'sw_vers'), `#!/bin/sh\necho ${swVers}\n`);
  writeFileSync(join(bin, 'launchctl'), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`);
  chmodSync(join(bin, 'sw_vers'), 0o755);
  chmodSync(join(bin, 'launchctl'), 0o755);
  writeFileSync(log, '');
  const r = spawnSync('bash', [join(dir, 'preinstall')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BREEZE_SW_VERS: join(bin, 'sw_vers') },
  });
  return { r, launchctlLog: readFileSync(log, 'utf8') };
}

test('preinstall refuses a Mac below the floor and touches nothing', () => {
  const { r, launchctlLog } = runPreinstall({ floor: '99.0', swVers: '15.0' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Breeze Agent requires macOS 99\.0 or later\. This Mac runs macOS 15\.0\./);
  assert.equal(launchctlLog, '');
});

test('preinstall allows a Mac at or above the floor', () => {
  const { r, launchctlLog } = runPreinstall({ floor: '13.0', swVers: '15.0' });
  assert.equal(r.status, 0);
  assert.notEqual(launchctlLog, '');
});

test('preinstall continues when the floor is an unrendered placeholder', () => {
  const { r, launchctlLog } = runPreinstall({ floor: '__BREEZE_MIN_MACOS__', swVers: '15.0' });
  assert.equal(r.status, 0);
  assert.notEqual(launchctlLog, '');
});

test('preinstall continues when os-floor.sh is missing', () => {
  const { r, launchctlLog } = runPreinstall({ floor: '99.0', swVers: '15.0', withOsFloor: false });
  assert.equal(r.status, 0);
  assert.notEqual(launchctlLog, '');
});

test('preinstall continues when sw_vers reports the compat version', () => {
  const { r, launchctlLog } = runPreinstall({ floor: '13.0', swVers: '10.16' });
  assert.equal(r.status, 0);
  assert.notEqual(launchctlLog, '');
});
