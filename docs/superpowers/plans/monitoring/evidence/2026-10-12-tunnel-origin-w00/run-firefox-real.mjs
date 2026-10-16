// W00 Task 0.3: stock (non-Playwright) Firefox, headless, throwaway profile, stock cookie
// prefs. Playwright cannot drive stock Firefox, so this launches the binary at /run and
// polls the harness for the run's `done` report.
//
// Usage: node run-firefox-real.mjs [http|https] [/path/to/firefox]
// user.js changes only what is needed to run unattended: no first-run UI, and popups allowed
// (dom.disable_open_during_load=false) so the scripted new-tab and partition-check flows can
// open without a user gesture. Cookie and tracking-protection prefs are left at stock values.
// https needs the Caddy internal CA trusted, which a throwaway profile does not have, so
// only http is meaningful here (stock Firefox accepts Secure cookies on http://*.localhost;
// see the secure-cookie probe in the result).
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scheme = process.argv[2] ?? 'http';
const bin = process.argv[3] ?? '/Applications/Firefox.app/Contents/MacOS/firefox';
const port = scheme === 'https' ? 18443 : 18080;
const version = execFileSync(bin, ['--version']).toString().trim();
const rid = `ffstock${scheme}${Date.now().toString(36)}`;

const profile = mkdtempSync(path.join(tmpdir(), 'tunnel-w00-ff-'));
writeFileSync(path.join(profile, 'user.js'), [
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.aboutwelcome.enabled", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
  'user_pref("browser.startup.homepage_override.mstone", "ignore");',
  'user_pref("dom.disable_open_during_load", false);',
].join('\n'));

const child = spawn(bin, ['--headless', '--no-remote', '--profile', profile, `${scheme}://app.localhost:${port}/run?rid=${rid}`], { stdio: 'ignore' });
const meta = { profile: 'firefox-stock', scheme, rid, browserVersion: version };
let results;
const deadline = Date.now() + 90_000;
for (;;) {
  results = await (await fetch(`http://127.0.0.1:18080/__results?rid=${rid}`)).json();
  if (results.reports.some((r) => r.flow === 'run' && r.stage === 'done')) break;
  if (Date.now() > deadline) { meta.runError = 'timeout waiting for done'; break; }
  await new Promise((r) => setTimeout(r, 1000));
}
child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 1500));
rmSync(profile, { recursive: true, force: true });
mkdirSync(path.join(here, 'results'), { recursive: true });
const file = path.join(here, 'results', `firefox-stock-${scheme}.json`);
writeFileSync(file, JSON.stringify({ meta, ...results }, null, 2));
console.log(`${version} ${scheme}: ${results.log.length} requests, ${results.reports.length} reports${meta.runError ? ' ' + meta.runError : ''}`);
