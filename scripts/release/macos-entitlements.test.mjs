// Contract for the macOS hardened-runtime entitlements (#10375).
//
// breeze-agent runs the YARA engine (yaraxwasm on wazero), which executes
// machine code it compiles into anonymous memory without MAP_JIT. Under the
// hardened runtime that needs com.apple.security.cs.allow-unsigned-executable-memory
// or the kernel SIGKILLs the agent on its first security scan. The exception
// is scoped to breeze-agent: backup, desktop-helper and watchdog are signed
// with the helpers set, which must stay exactly what they shipped with.
//
// The Go side (agent/internal/yarascan/yarac/execmem_darwin_test.go) proves
// on a Mac that these plists behave as claimed; this suite pins that every
// signing lane applies the right plist to the right binary.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(join(REPO_ROOT, path), 'utf8');

const UEM = 'com.apple.security.cs.allow-unsigned-executable-memory';
const AGENT_PLIST = 'agent/entitlements/agent-macos.entitlements.plist';
const HELPERS_PLIST = 'agent/entitlements/helpers-macos.entitlements.plist';

// Boolean-true keys of a flat entitlements plist, ignoring XML comments.
function trueKeys(path) {
  const xml = read(path).replace(/<!--[\s\S]*?-->/gu, '');
  const keys = [...xml.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\s*\/>/gu)];
  const all = [...xml.matchAll(/<key>([^<]+)<\/key>/gu)].map((m) => m[1]);
  assert.equal(keys.length, all.length, `${path}: every entitlement must be a boolean`);
  return keys.filter((m) => m[2] === 'true').map((m) => m[1]).sort();
}

function signStep(path, stepName) {
  const text = read(path);
  const start = text.indexOf(`- name: ${stepName}`);
  assert.notEqual(start, -1, `${path} must have a "${stepName}" step`);
  const next = text.indexOf('\n      - name:', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

test('agent entitlements carry exactly the YARA exception plus library validation', () => {
  assert.deepEqual(trueKeys(AGENT_PLIST), [
    UEM,
    'com.apple.security.cs.disable-library-validation',
  ]);
});

test('helper entitlements are unchanged and never gain the YARA exception', () => {
  assert.deepEqual(trueKeys(HELPERS_PLIST), ['com.apple.security.cs.disable-library-validation']);
});

test('the dev entitlements let a dev-pushed agent run the engine too', () => {
  assert.ok(trueKeys('agent/dev-entitlements.plist').includes(UEM));
});

for (const [workflow, step, prefix] of [
  ['.github/workflows/release.yml', 'Sign binaries', ''],
  ['selfhost-signing-template/.github/workflows/sign-release.yml', 'Sign binaries (hardened runtime + entitlements)', 'breeze/'],
]) {
  test(`${workflow} signs breeze-agent with the agent plist and the rest with the helpers plist`, () => {
    const run = signStep(workflow, step);
    assert.match(run, /--entitlements "\$entitlements"/u, 'codesign must use the per-binary plist');
    assert.doesNotMatch(run, /--entitlements (?!"\$entitlements"|- )/u, 'no hard-coded plist may sign every binary');
    const arms = [...run.matchAll(/^\s*(staging\/breeze-agent-darwin-\*|\*)\)\s*(.+?);;$/gmu)];
    assert.equal(arms.length, 2, 'one case arm for breeze-agent, one for everything else');
    const [agentArm, restArm] = arms.map((m) => m[2]);
    assert.equal(arms[0][1], 'staging/breeze-agent-darwin-*');
    const agentPlist = `${prefix}${AGENT_PLIST}`;
    const helpersPlist = `${prefix}${HELPERS_PLIST}`;
    if (prefix) {
      // The BYO template may sign a release that predates helpers-macos.
      assert.match(run, new RegExp(`agent_entitlements=${agentPlist.replaceAll('.', '\\.')}`, 'u'));
      assert.match(run, new RegExp(`helpers_entitlements=${helpersPlist.replaceAll('.', '\\.')}`, 'u'));
      assert.match(agentArm, /entitlements="\$agent_entitlements"/u);
      assert.match(restArm, /entitlements="\$helpers_entitlements"; want_uem=no/u);
    } else {
      assert.match(agentArm, new RegExp(`entitlements=${agentPlist.replaceAll('.', '\\.')}; want_uem=yes`, 'u'));
      assert.match(restArm, new RegExp(`entitlements=${helpersPlist.replaceAll('.', '\\.')}; want_uem=no`, 'u'));
    }
    // The signed result is asserted, not assumed.
    assert.match(run, /codesign -d --entitlements - --xml "\$bin"/u);
    assert.ok(run.includes(`<key>${UEM}</key><true/>`));
    assert.match(run, /if \[ "\$has_uem" != "\$want_uem" \]; then[\s\S]*?exit 1/u);
  });
}

test('the dev-build artifact hands the hosted signer the agent plist', () => {
  const text = read('.github/workflows/dev-build-agent.yml');
  assert.ok(text.includes(AGENT_PLIST));
  assert.ok(!text.includes(HELPERS_PLIST), 'the dev-build artifact holds breeze-agent only');
});
