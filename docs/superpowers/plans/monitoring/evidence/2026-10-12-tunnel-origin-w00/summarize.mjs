// Summarise results/*.json (written by run-playwright.mjs / run-firefox-real.mjs) into
// the facts the spec's W00 results table needs. Prints JSON lines and writes
// results/summary.json. Usage: node summarize.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
const has = (cookie, name) => new RegExp(`(^|; )${name.replace(/[$]/g, '\\$&')}=`).test(cookie ?? '');
const names = (cookie) => (cookie ? cookie.split('; ').map((c) => c.split('=')[0]) : []);

const out = {};
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'summary.json').sort()) {
  const { meta, log = [], reports = [] } = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  const rid = meta.rid;
  const L = (label) => `${label}-${rid}`;
  const req = (label, p, method) => log.filter((e) => e.label === L(label) && e.path === p && (!method || e.method === method));
  const first = (label, p, method) => req(label, p, method)[0] ?? null;
  const rep = (label, stage) => reports.find((r) => r.label === L(label) && r.stage === stage) ?? null;
  const flowEnd = (flow) => reports.find((r) => r.flow === flow && r.stage === 'flow-end')?.got ?? 'missing';
  const view = (e) => (e ? { sfs: e.secFetchSite, cookies: names(e.cookie) } : 'not requested');

  const top = log.find((e) => e.host === 'app.localhost' && e.path === '/__echo');
  const topRep = reports.find((r) => r.flow === 'secprobe-top');
  const frameEcho = first('p', '/__echo');
  const pRep = rep('p', 'home');

  const s1After = log.filter((e) => e.label === L('s1'));
  const tossAt = reports.find((r) => r.label === L('s2') && r.stage === 'toss');
  const crossReqs = s1After.filter((e) => ['/probe', '/xget', '/reboot', '/formpost'].includes(e.path) && !(e.origin ?? '').includes(L('s1')) && e.secFetchSite !== 'same-origin');

  out[path.basename(f, '.json')] = {
    browser: `${meta.profile} ${meta.browserVersion ?? ''}`.trim(),
    scheme: meta.scheme,
    errors: [meta.launchError, meta.runError, meta.cdpCookieControls && `cdp:${meta.cdpCookieControls}`].filter(Boolean),
    secureProbe: {
      topLevelApp: { isSecureContext: topRep?.isSecureContext ?? null, cookiesBack: names(top?.cookie), sfsPresent: top ? top.secFetchSite !== null : null },
      framedTunnel: { isSecureContext: pRep?.isSecureContext ?? null, cookiesBack: names(frameEcho?.cookie), sfs: frameEcho?.secFetchSite ?? null },
      anySecFetchSiteHeader: log.some((e) => e.secFetchSite !== null),
    },
    iframeBootstrap: {
      result: flowEnd('iframe-bootstrap'),
      enter: view(first('b', '/__bz/enter')),
      ping: view(first('b', '/__bz/ping')),
      root: view(first('b', '/')),
      loginPost: view(first('b', '/login', 'POST')),
      home: view(first('b', '/home')),
      rootPage: rep('b', 'root') && { localStorage: rep('b', 'root').localStorage, docCookieWrite: rep('b', 'root').docCookieWrite, isSecureContext: rep('b', 'root').isSecureContext },
      homeSawDeviceSession: rep('b', 'home')?.serverSawSession ?? null,
      cookieBlockedSignal: !!rep('b', 'cookie-blocked'),
      sameHostTopLevelAfterward: view(first('b', '/__echo')),
    },
    iframeBootstrapSandboxed: {
      result: flowEnd('iframe-bootstrap-sandboxed'),
      root: view(first('x', '/')),
      home: view(first('x', '/home')),
      rootPage: rep('x', 'root') && { localStorage: rep('x', 'root').localStorage, docCookieWrite: rep('x', 'root').docCookieWrite },
    },
    iframe302: {
      result: flowEnd('iframe-302'),
      enter: view(first('r', '/__bz/enter')),
      root: view(first('r', '/')),
      home: view(first('r', '/home')),
    },
    tab: {
      result: flowEnd('tab'),
      enter: view(first('n', '/__bz/enter')),
      ping: view(first('n', '/__bz/ping')),
      root: view(first('n', '/')),
      loginPost: view(first('n', '/login', 'POST')),
      home: view(first('n', '/home')),
      rootPage: rep('n', 'root') && { localStorage: rep('n', 'root').localStorage, docCookieWrite: rep('n', 'root').docCookieWrite },
    },
    sibling: {
      s1Login: flowEnd('sibling-s1'),
      tossDocCookie: tossAt?.docCookieAfterToss ?? 'no toss report',
      crossTunnelRequests: crossReqs.map((e) => ({ method: e.method, path: e.path, sfs: e.secFetchSite, mode: e.secFetchMode, origin: e.origin, bztAttached: has(e.cookie, '__Host-bzt'), cookies: names(e.cookie) })),
      s1AfterLoad: view(first('s1', '/after')),
    },
  };
}
writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(out, null, 2));
for (const [k, v] of Object.entries(out)) console.log(k, JSON.stringify(v, null, 1));
