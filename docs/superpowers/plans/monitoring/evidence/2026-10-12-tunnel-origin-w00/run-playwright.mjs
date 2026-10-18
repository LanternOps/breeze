// W00 Task 0.3 runner: drives harness-server.mjs's /run page in each browser profile and
// writes results/<profile>-<scheme>.json (raw server log + page reports) plus a summary.
//
// Usage (repo root, harness running; for https also run tls-front.sh):
//   node docs/superpowers/plans/monitoring/evidence/2026-10-12-tunnel-origin-w00/run-playwright.mjs http [profile...]
//   node docs/superpowers/plans/monitoring/evidence/2026-10-12-tunnel-origin-w00/run-playwright.mjs https [profile...]
// Profiles: chromium, chromium-3pc-blocked, chrome-stable, chrome-stable-3pc-blocked,
//           firefox-pw-default, firefox-real-prefs, webkit
//
// Playwright notes that bound what this proves:
// - Playwright launches Chromium with popup blocking disabled and Firefox with
//   dom.disable_open_during_load=false, so the tab flow succeeding without a user
//   gesture is Playwright-specific.
// - Playwright's Firefox build ships network.cookie.cookieBehavior=4 and
//   network.cookie.CHIPS.enabled=false (its playwright.cfg). `firefox-real-prefs`
//   overrides both to what stock Firefox ships (5 / true, read from omni.ja).
// - Playwright's WebKit stands in for Safari. It is an approximation: no ITP state,
//   not Safari's networking stack, not Safari's cookie policy UI.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../../..');
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_PATH
  ?? path.join(repoRoot, 'node_modules/.pnpm/playwright@1.62.1/node_modules/playwright'));

const scheme = process.argv[2] ?? 'http';
const PORT = scheme === 'https' ? 18443 : 18080;
const RESULTS_URL = 'http://127.0.0.1:18080/__results';

const profiles = {
  'chromium': { type: 'chromium', opts: {} },
  'chromium-3pc-blocked': { type: 'chromium', opts: { args: ['--test-third-party-cookie-phaseout'] }, cdpBlock3pc: true, prefs3pcBlock: true },
  'chrome-stable': { type: 'chromium', opts: { channel: 'chrome' } },
  'chrome-stable-3pc-blocked': { type: 'chromium', opts: { channel: 'chrome', args: ['--test-third-party-cookie-phaseout'] }, cdpBlock3pc: true, prefs3pcBlock: true },
  'firefox-pw-default': { type: 'firefox', opts: {} },
  'firefox-real-prefs': { type: 'firefox', opts: { firefoxUserPrefs: { 'network.cookie.cookieBehavior': 5, 'network.cookie.CHIPS.enabled': true } } },
  'webkit': { type: 'webkit', opts: {} },
};

const wanted = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(profiles);
mkdirSync(path.join(here, 'results'), { recursive: true });

for (const name of wanted) {
  const prof = profiles[name];
  if (!prof) { console.error(`unknown profile ${name}`); continue; }
  const rid = `${name.replace(/[^a-z0-9]/g, '')}${scheme}${Date.now().toString(36)}`;
  let browser;
  const meta = { profile: name, scheme, rid };
  try {
    let context;
    if (prof.prefs3pcBlock) {
      // "Block third-party cookies" as the settings UI stores it, in a throwaway profile.
      // Whether it took effect is judged from the ctl3p control cookie, not assumed.
      const dir = mkdtempSync(path.join(tmpdir(), 'tunnel-w00-chrome-'));
      mkdirSync(path.join(dir, 'Default'), { recursive: true });
      writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ profile: { cookie_controls_mode: 1, block_third_party_cookies: true } }));
      context = await pw[prof.type].launchPersistentContext(dir, { headless: true, ignoreHTTPSErrors: true, ...prof.opts });
      browser = { version: () => context.browser()?.version() ?? 'persistent', close: () => context.close() };
      meta.userDataDirPrefs = 'cookie_controls_mode=1, block_third_party_cookies=true';
    } else {
      browser = await pw[prof.type].launch({ headless: true, ...prof.opts });
      context = await browser.newContext({ ignoreHTTPSErrors: true });
    }
    meta.browserVersion = browser.version();
    const page = context.pages()[0] ?? await context.newPage();
    if (prof.cdpBlock3pc) {
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send('Network.setCookieControls', {
          enableThirdPartyCookieRestriction: true,
          disableThirdPartyCookieMetadata: false,
          disableThirdPartyCookieHeuristics: false,
        });
        meta.cdpCookieControls = 'applied';
      } catch (e) { meta.cdpCookieControls = `failed: ${e.message.split('\n')[0]}`; }
    }
    const resolveErrors = [];
    page.on('requestfailed', (r) => resolveErrors.push(`${r.url()} ${r.failure()?.errorText}`));
    context.on('page', (p) => p.on('requestfailed', (r) => resolveErrors.push(`[tab] ${r.url()} ${r.failure()?.errorText}`)));
    await page.goto(`${scheme}://app.localhost:${PORT}/run?rid=${rid}`);
    await page.waitForFunction(() => document.title === 'done', null, { timeout: 90_000 }).catch((e) => { meta.runError = e.message.split('\n')[0]; });
    meta.requestFailures = resolveErrors;
  } catch (e) {
    meta.launchError = e.message.split('\n')[0];
  } finally {
    await browser?.close();
  }
  const results = await (await fetch(`${RESULTS_URL}?rid=${rid}`)).json();
  const file = path.join(here, 'results', `${name}-${scheme}.json`);
  writeFileSync(file, JSON.stringify({ meta, ...results }, null, 2));
  console.log(`${name} ${scheme}: ${meta.browserVersion ?? meta.launchError} → ${path.relative(repoRoot, file)} (${results.log.length} requests, ${results.reports.length} reports)${meta.runError ? ' RUN ERROR: ' + meta.runError : ''}`);
}
