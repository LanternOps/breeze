// Packaging checks for the launchd runner and runbook (W06b B4, #10750).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, f), 'utf8');
const LABEL = 'com.lanternops.breeze-ci-shepherd';

test('plist template has no absolute home path', () => {
  const t = read(`${LABEL}.plist.template`);
  assert.ok(!t.includes('/Users/'));
  assert.ok(!/\/home\/[a-z]/i.test(t));
});

test('run.sh is strict, pinned to its own clone, and never destructive', () => {
  const s = read('run.sh');
  assert.match(s, /^#!\/(usr\/bin\/env bash|bin\/bash)\n/);
  assert.match(s, /^set -euo pipefail$/m);
  assert.ok(s.includes('checkout --quiet --detach FETCH_HEAD'));
  for (const bad of ['git stash', 'pkill', 'reset --hard']) assert.ok(!s.includes(bad), bad);
  const gitLines = s.split('\n').filter((l) => /(^|[\s;&|(])git\s/.test(l) && !l.trim().startsWith('#'));
  assert.ok(gitLines.length >= 3);
  for (const l of gitLines) {
    assert.ok(l.includes('git -C "$HOME_DIR/checkout"') || (/git clone /.test(l) && l.includes('"$HOME_DIR/checkout"')), `bare git: ${l}`);
  }
});

test('install.sh creates the clone before loading the job, and only touches that clone', () => {
  const s = read('install.sh');
  assert.ok(s.indexOf('git clone') !== -1 && s.indexOf('git clone') < s.indexOf('launchctl bootstrap'), 'clone before bootstrap');
  const gitLines = s.split('\n').filter((l) => /(^|[\s;&|(])git\s/.test(l) && !l.trim().startsWith('#'));
  for (const l of gitLines) {
    assert.ok(l.includes('git -C "$HOME_DIR/checkout"') || (/git clone /.test(l) && l.includes('"$HOME_DIR/checkout"')), `bare git: ${l}`);
  }
  for (const bad of ['git stash', 'pkill', 'reset --hard']) assert.ok(!s.includes(bad), bad);
});

test('README carries the runbook', () => {
  const r = read('README.md');
  assert.match(r, /^#{2,3} .*CI shepherd.*runbook/im);
  assert.ok(r.includes('gh variable set CI_SHEPHERD_MODE --body off -R LanternOps/breeze'));
  for (const l of ['hold', 'backoff', 'wait-main', 'ignore', 'resume', 'probe']) assert.ok(r.includes(`ci-shepherd:${l}`), l);
  assert.ok(r.includes(`launchctl bootout gui/$(id -u)/${LABEL}`));
});

test('install.sh --dry-run renders the plist and writes nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'shepherd-home-'));
  const out = execFileSync('bash', [join(here, 'install.sh'), '--dry-run'], { env: { ...process.env, HOME: home, USER: 'tester', PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.match(out, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(out, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.ok(out.includes(`<string>${LABEL}</string>`));
  assert.match(out, new RegExp(`<key>HOME</key>\\s*<string>${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));
  assert.ok(out.includes('<string>tester</string>'));
  assert.ok(out.includes('<string>/usr/bin:/bin</string>'));
  assert.ok(out.includes(`${home}/.local/share/breeze-ci-shepherd/checkout/scripts/ci-shepherd/run.sh`));
  assert.ok(!/__[A-Z_]+__/.test(out), 'unrendered placeholder');
  assert.ok(!existsSync(join(home, 'Library', 'LaunchAgents')) || readdirSync(join(home, 'Library', 'LaunchAgents')).length === 0);
});

test('no closing keywords in shipped text', () => {
  for (const f of ['README.md', 'run.sh', 'install.sh', `${LABEL}.plist.template`]) {
    assert.ok(!/\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#\d+/i.test(read(f)), f);
  }
});
