// W00 Task 0.3 spike harness (spec 2026-10-06 §4/§4a/§6, plan amendment 2). Not product code.
//
// One plain-HTTP Node server plays both sides:
//   app     http(s)://app.localhost:<port>            (the Breeze app's origin)
//   tunnels http(s)://<label>.tunnel.localhost:<port> (one origin per tunnel session)
// `app.localhost` and `tunnel.localhost` are different registrable domains under the
// default PSL rule, so the iframe is genuinely cross-site. Sibling tunnels share
// `tunnel.localhost`; `.localhost` is not on the PSL, so how a browser classifies two
// sibling tunnel hosts is that browser's unknown-TLD fallback (an approximation of
// production pre-PSL, not proof of it).
//
// HTTPS: run tls-front.sh, which puts Caddy (`tls internal`) on :18443 in front of this
// server. A request that arrives with `X-Forwarded-Proto: https` is treated as the
// https://…:18443 deployment; anything else as http://…:<listen port>.
//
// Driving: open `/run?rid=<id>` on the app host. That page runs every flow in sequence
// (secure-cookie probe, iframe bootstrap, iframe 302, new tab, sibling tunnels) with
// labels unique to the run, and every page reports to `/__report`. Read the outcome
// from `/__results?rid=<id>` (any host). run-playwright.mjs and run-firefox-real.mjs
// do exactly that.
import { createServer } from 'node:http';

const LISTEN_PORT = Number(process.env.HARNESS_PORT ?? 18080);
const LISTEN_HOST = process.env.HARNESS_LISTEN ?? '127.0.0.1';
const TLS_PORT = Number(process.env.HARNESS_TLS_PORT ?? 18443);
const APP_HOST = 'app.localhost';
const SUFFIX = 'tunnel.localhost';

const log = [];
const reports = [];

function originFor(req, host) {
  const https = req.headers['x-forwarded-proto'] === 'https';
  return https ? `https://${host}:${TLS_PORT}` : `http://${host}:${LISTEN_PORT}`;
}
const ridOfLabel = (label) => label.split('-').slice(1).join('-');

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 65536) req.destroy(); });
    req.on('end', () => resolve(b));
  });
}

// Shared page script: collect what the page can observe, report it same-origin,
// and postMessage it to the app when framed. `next` runs after reporting.
function pageReport(appOrigin, payload, next = '') {
  return `<script>(function(){
var r=${JSON.stringify(payload)};
r.isSecureContext=window.isSecureContext; r.framed=(window.parent!==window);
try{localStorage.setItem('k','v');r.localStorage=localStorage.getItem('k')==='v';}catch(e){r.localStorage='throws:'+e.name;}
try{document.cookie=r.framed?'jsdev=1; Path=/; Secure; SameSite=None; Partitioned':'jsdev=1; Path=/; Secure; SameSite=Lax';r.docCookieWrite=/(^|; )jsdev=1/.test(document.cookie);}catch(e){r.docCookieWrite='throws:'+e.name;}
r.docCookie=document.cookie;
fetch('/probe',{method:'POST',body:'x'}).then(function(x){return x.text()},function(){return 'failed'}).then(function(t){r.probe=t;done();});
function done(){
 fetch('/__report',{method:'POST',body:JSON.stringify(r),keepalive:true}).catch(function(){});
 if(r.framed){parent.postMessage(r,${JSON.stringify(appOrigin)});}
 document.title=JSON.stringify(r);
 ${next}
}})();</script>`;
}

// The app page that drives every flow. Each flow uses tunnel labels unique to the run.
function runPage(appOrigin, rid, tunnelOrigin) {
  return `<!doctype html><title>run ${rid}</title><body><pre id="out"></pre><script>
var RID=${JSON.stringify(rid)}, T=${JSON.stringify(tunnelOrigin)};
function tun(l){return T.replace('__LABEL__', l+'-'+RID);}
var inbox=[]; addEventListener('message',function(e){inbox.push({origin:e.origin,data:e.data});});
function report(o){o.rid=RID;return fetch('/__report',{method:'POST',body:JSON.stringify(o)});}
function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
function frame(src,sandbox){var f=document.createElement('iframe');f.style.cssText='width:600px;height:120px';if(sandbox)f.setAttribute('sandbox',sandbox);f.src=src;document.body.appendChild(f);return f;}
async function waitMsg(pred,ms){var t=Date.now();while(Date.now()-t<ms){for(var i=0;i<inbox.length;i++){if(pred(inbox[i]))return inbox[i];}await sleep(100);}return null;}
async function waitReport(label,stage,ms){var t=Date.now();while(Date.now()-t<ms){var r=await (await fetch('/__results?rid='+RID)).json();
 if(r.reports.some(function(x){return x.label===label+'-'+RID&&x.stage===stage;}))return true;await sleep(250);}return false;}
async function flowFrame(name,label,src,ms,sandbox){
 var f=frame(src,sandbox);
 var m=await waitMsg(function(x){return x.data&&((x.data.label===label+'-'+RID&&x.data.stage==='home')||(x.data.type==='breeze-tunnel-cookie-blocked'&&x.origin.indexOf(label+'-')>=0));},ms);
 await report({flow:name,stage:'flow-end',got:m?(m.data.type||m.data.stage):'timeout',messages:inbox.filter(function(x){return x.origin.indexOf(label+'-'+RID)>=0;})});
 return f;
}
(async function(){
 // 0. Top-level secure-cookie probe on the app host (cookies were set on this response).
 await fetch('/__echo?probe=top&rid='+RID);
 await report({flow:'secprobe-top',stage:'page',isSecureContext:window.isSecureContext,docCookie:document.cookie});
 // 0b. Same probe in a third-party iframe on a tunnel host.
 await flowFrame('secprobe-frame','p',tun('p')+'/__secprobe',5000);
 // 1. Iframe: bootstrap page (plan G1 resolution).
 await flowFrame('iframe-bootstrap','b',tun('b')+'/__bz/enter?variant=bootstrap',8000);
 // 1b. Partition check: load the same tunnel host top-level. A Partitioned cookie set in
 //     the iframe must not appear here; the unpartitioned control shows whether the
 //     browser partitions all third-party cookies anyway (Firefox TCP) or not.
 var pw=window.open(tun('b')+'/__echo?toplevel=1','_blank');
 await sleep(1500); try{pw&&pw.close();}catch(e){}
 await report({flow:'partition-check',stage:'flow-end',got:pw?'opened':'popup-blocked'});
 // 1c. Same bootstrap flow inside the exact host-mode sandbox from spec §6.
 await flowFrame('iframe-bootstrap-sandboxed','x',tun('x')+'/__bz/enter?variant=bootstrap',8000,
  'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads');
 // 2. Iframe: 302 to / (spec §4 as written).
 await flowFrame('iframe-302','r',tun('r')+'/__bz/enter?variant=302',8000);
 // 3. New tab: about:blank synchronously, opener=null, then location.replace.
 var w=window.open('about:blank','_blank');
 if(!w){await report({flow:'tab',stage:'flow-end',got:'popup-blocked'});}
 else{w.opener=null;w.location.replace(tun('n')+'/__bz/enter?mode=tab');
  var ok=await waitReport('n','home',8000);await report({flow:'tab',stage:'flow-end',got:ok?'home':'timeout'});try{w.close();}catch(e){}}
 // 4. Sibling tunnels: s1 logs in; s2 (same app tab, same partition) tosses a cookie and
 //    sends credentialed requests at s1; then s1 is loaded again to see what it carries.
 await flowFrame('sibling-s1','s1',tun('s1')+'/__bz/enter?variant=bootstrap',8000);
 frame(tun('s2')+'/toss?target='+encodeURIComponent(tun('s1')));
 await sleep(2500);
 frame(tun('s1')+'/after');
 await sleep(1500);
 await report({flow:'run',stage:'done'});
 document.getElementById('out').textContent='done '+RID;
 document.title='done';
})();
</script>`;
}

createServer(async (req, res) => {
  const hostHeader = req.headers.host ?? '';
  const host = hostHeader.split(':')[0].toLowerCase();
  const url = new URL(req.url, 'http://x');
  const appOrigin = originFor(req, APP_HOST);

  if (url.pathname === '/__results') {
    const rid = url.searchParams.get('rid');
    const mine = (e) => e.rid === rid;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ log: log.filter(mine), reports: reports.filter(mine) }));
    return;
  }

  const isTunnel = host.endsWith(`.${SUFFIX}`);
  const label = isTunnel ? host.slice(0, -(SUFFIX.length + 1)) : null;
  const rid = isTunnel ? ridOfLabel(label) : (url.searchParams.get('rid') ?? null);

  if (url.pathname === '/__report' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const r = JSON.parse(body);
      reports.push({ ...r, rid: r.rid ?? rid, label: r.label ?? label, reportedFrom: host, t: Date.now() });
    } catch { /* ignore */ }
    return send(res, 204, '');
  }

  const cookie = req.headers.cookie ?? '';
  log.push({
    t: Date.now(), rid, host, label, scheme: req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http',
    method: req.method, path: url.pathname, search: url.search, cookie,
    secFetchSite: req.headers['sec-fetch-site'] ?? null, secFetchDest: req.headers['sec-fetch-dest'] ?? null,
    secFetchMode: req.headers['sec-fetch-mode'] ?? null, origin: req.headers.origin ?? null,
    referer: req.headers.referer ?? null,
  });

  const probeCookies = [
    'sp_plain=1; Path=/',
    'sp_secure=1; Path=/; Secure',
    '__Host-sp_host=1; Path=/; Secure',
    'sp_none=1; Path=/; Secure; SameSite=None',
    'sp_part=1; Path=/; Secure; SameSite=None; Partitioned',
  ];

  if (host === APP_HOST) {
    if (url.pathname === '/run') {
      const tunnelOrigin = originFor(req, `__LABEL__.${SUFFIX}`);
      return send(res, 200, runPage(appOrigin, rid ?? 'norid', tunnelOrigin), { 'set-cookie': probeCookies });
    }
    if (url.pathname === '/__echo') return send(res, 200, cookie, { 'content-type': 'text/plain' });
    return send(res, 404, 'app: unknown path');
  }
  if (!isTunnel) return send(res, 404, 'unknown host');

  const tunnelOrigin = originFor(req, host);
  const csp = `frame-ancestors ${appOrigin} 'self'`;
  const tabCtx = /(^|; )__Host-bzt-top=/.test(cookie);
  const deviceCookieAttrs = tabCtx ? 'Path=/; Secure; SameSite=Lax' : 'Path=/; Secure; SameSite=None; Partitioned';
  const sawAuth = /(^|; )__Host-bzt(-top)?=/.test(cookie);

  if (url.pathname === '/__secprobe') {
    return send(res, 200, `<!doctype html><script>
fetch('/__echo').then(function(r){return r.text()}).then(function(t){
 var r={label:${JSON.stringify(label)},stage:'home',probe:'secprobe',echo:t,docCookie:document.cookie,isSecureContext:window.isSecureContext};
 fetch('/__report',{method:'POST',body:JSON.stringify(r)});parent.postMessage(r,${JSON.stringify(appOrigin)});});
</script>`, { 'set-cookie': probeCookies, 'content-security-policy': csp });
  }
  if (url.pathname === '/__echo') return send(res, 200, cookie, { 'content-type': 'text/plain' });

  if (url.pathname === '/__bz/enter') {
    const tab = url.searchParams.get('mode') === 'tab';
    const auth = tab
      ? [`__Host-bzt-top=${label}; Path=/; Secure; HttpOnly; SameSite=Lax`]
      // Control cookie: unpartitioned SameSite=None. If it comes back, third-party
      // cookies were simply allowed, so a returning __Host-bzt proves nothing about CHIPS.
      : [`__Host-bzt=${label}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`,
         `ctl3p=${label}; Path=/; Secure; HttpOnly; SameSite=None`];
    if (url.searchParams.get('variant') === '302') {
      res.writeHead(302, { location: '/', 'set-cookie': auth, 'content-security-policy': csp, 'cache-control': 'no-store' });
      return res.end();
    }
    return send(res, 200, `<!doctype html><p>entering</p><script>
fetch('/__bz/ping',{credentials:'same-origin',cache:'no-store'}).then(function(r){
 if(r.status===204){location.replace('/');}
 else{var m={type:'breeze-tunnel-cookie-blocked',label:${JSON.stringify(label)},pingStatus:r.status};
  fetch('/__report',{method:'POST',body:JSON.stringify(Object.assign({stage:'cookie-blocked'},m))});
  if(parent!==window){parent.postMessage(m,${JSON.stringify(appOrigin)});}}
});</script>`, { 'set-cookie': auth, 'content-security-policy': csp });
  }
  if (url.pathname === '/__bz/ping') return send(res, sawAuth ? 204 : 401, '');

  if (url.pathname === '/') {
    return send(res, 200, `<!doctype html><form id="f" method="post" action="/login"><input name="u" value="x"></form>
${pageReport(appOrigin, { label, stage: 'root', serverSawAuth: sawAuth, serverSawControl: /(^|; )ctl3p=/.test(cookie) }, "setTimeout(function(){document.getElementById('f').submit();},50);")}`,
      { 'content-security-policy': csp, 'set-cookie': `dev=${label}; ${deviceCookieAttrs}` });
  }
  if (url.pathname === '/login' && req.method === 'POST') {
    res.writeHead(303, { location: '/home', 'set-cookie': `devsess=${label}; ${deviceCookieAttrs}`, 'content-security-policy': csp, 'cache-control': 'no-store' });
    return res.end();
  }
  if (url.pathname === '/home') {
    return send(res, 200, `<!doctype html>${pageReport(appOrigin, {
      label, stage: 'home', serverSawAuth: sawAuth, serverSawSession: /(^|; )devsess=/.test(cookie), serverSawDev: /(^|; )dev=/.test(cookie),
    })}`, { 'content-security-policy': csp });
  }
  if (url.pathname === '/toss') {
    // From sibling s2: plant a cookie on the shared parent (pre-PSL cookie tossing),
    // then send credentialed requests at s1.
    const target = url.searchParams.get('target') ?? '';
    return send(res, 200, `<!doctype html><body><script>
document.cookie='toss=${label}; Domain=${SUFFIX}; Path=/; Secure; SameSite=None; Partitioned';
document.cookie='tossnp=${label}; Domain=${SUFFIX}; Path=/; Secure; SameSite=None';
var r={label:${JSON.stringify(label)},stage:'toss',docCookieAfterToss:document.cookie};
fetch('/__report',{method:'POST',body:JSON.stringify(r)});
fetch(${JSON.stringify(target)}+'/probe',{method:'POST',mode:'no-cors',credentials:'include',body:'x'}).catch(function(){});
fetch(${JSON.stringify(target)}+'/xget',{mode:'no-cors',credentials:'include'}).catch(function(){});
var i=new Image(); i.src=${JSON.stringify(target)}+'/reboot';
var f=document.createElement('form');f.method='post';f.action=${JSON.stringify(target)}+'/formpost';f.target='sink';
var s=document.createElement('iframe');s.name='sink';document.body.appendChild(s);document.body.appendChild(f);setTimeout(function(){f.submit();},100);
</script>`, { 'content-security-policy': csp });
  }
  return send(res, 200, `ok ${req.method} ${url.pathname} sfs=${req.headers['sec-fetch-site'] ?? '-'} cookie=${cookie}`, { 'content-type': 'text/plain' });
}).listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`tunnel-origin W00 harness: http://${APP_HOST}:${LISTEN_PORT}/run?rid=<id> (https via tls-front.sh on :${TLS_PORT})`);
});
