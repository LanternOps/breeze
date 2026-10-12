// Compact one-screen view of results/summary.json (run summarize.mjs first).
// Each request prints as <Sec-Fetch-Site>[cookie names the server received].
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const s = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'results', 'summary.json'), 'utf8'));
const c = (a) => (Array.isArray(a) ? a.join(',') : a);
const f = (x) => (typeof x === 'string' ? x : `${x.sfs}[${c(x.cookies)}]`);
const only = process.argv.slice(2);
for (const [k, v] of Object.entries(s)) {
  if (only.length && !only.some((o) => k.includes(o))) continue;
  const b = v.iframeBootstrap, r = v.iframe302, t = v.tab, sb = v.sibling, sp = v.secureProbe;
  console.log(`### ${k} | ${v.browser} | ${c(v.errors)}`);
  console.log(` secprobe top: isc=${sp.topLevelApp.isSecureContext} back=${c(sp.topLevelApp.cookiesBack)} | frame: back=${c(sp.framedTunnel.cookiesBack)} | any SFS header=${sp.anySecFetchSiteHeader}`);
  console.log(` boot: ${b.result} enter=${f(b.enter)} ping=${f(b.ping)} root=${f(b.root)} home=${f(b.home)} LS=${b.rootPage?.localStorage} jsW=${b.rootPage?.docCookieWrite}`);
  console.log(`   same host top-level afterwards: ${f(b.sameHostTopLevelAfterward ?? 'n/a')}`);
  const x = v.iframeBootstrapSandboxed;
  if (x) console.log(` sandboxed boot: ${x.result} root=${f(x.root)} home=${f(x.home)} LS=${x.rootPage?.localStorage} jsW=${x.rootPage?.docCookieWrite}`);
  console.log(` 302: ${r.result} root=${f(r.root)} home=${f(r.home)}`);
  console.log(` tab: ${t.result} enter=${f(t.enter)} root=${f(t.root)} home=${f(t.home)} LS=${t.rootPage?.localStorage} jsW=${t.rootPage?.docCookieWrite}`);
  console.log(` sibling: s1=${sb.s1Login} toss(doc.cookie in s2)=${sb.tossDocCookie} s1 reload=${f(sb.s1AfterLoad)}`);
  for (const x of sb.crossTunnelRequests) console.log(`   s2→s1 ${x.method} ${x.path} sfs=${x.sfs} bzt=${x.bztAttached} [${c(x.cookies)}]`);
}
