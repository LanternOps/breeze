// Shared Playwright session helper for the Wisp harness.
//
// Reads the wt-stack descriptor (BREEZE_STACK_DESCRIPTOR, else
// <repo root>/.breeze-stack.json), logs in with TOTP when the user has one
// enrolled, keeps the session in .state/, and carries a virtual WebAuthn
// authenticator whose credentials persist in .state/ so approver-device
// step-up works headless across runs.
//
// Everything this writes lives in e2e-tests/wisp-eval/.state/ (gitignored, 0700).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('@playwright/test');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const STATE_DIR = path.join(HERE, '.state');
fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(STATE_DIR, 0o700);

const DESCRIPTOR = process.env.BREEZE_STACK_DESCRIPTOR || path.join(ROOT, '.breeze-stack.json');
function loadStack() {
  if (!fs.existsSync(DESCRIPTOR)) throw new Error(`no stack descriptor at ${DESCRIPTOR}; run \`pnpm wt-stack up\` or set BREEZE_STACK_DESCRIPTOR`);
  return JSON.parse(fs.readFileSync(DESCRIPTOR, 'utf8'));
}
const stack = loadStack();
const BASE = stack.baseUrl;
const USER = process.env.WUSER || 'admin';
const statePath = (name) => path.join(STATE_DIR, name);
const usersFile = statePath('users.json');
const users = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile, 'utf8')) : {};
const cred = users[USER] || { email: (stack.admin && stack.admin.email) || 'admin@breeze.local', password: (stack.admin && stack.admin.password) || 'BreezeAdmin123!' };
const STORAGE = statePath(`state-${USER}.json`);
const PASSKEYS = statePath(`passkeys-${USER}.json`);
const SECRET_FILE = statePath(`totp-${USER}.txt`);
const LAST_FILE = statePath(`totp-${USER}.last`);

function writePrivate(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
}

function b32(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const v = A.indexOf(c);
    if (v >= 0) bits += v.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secret, at = Date.now()) {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = crypto.createHmac('sha1', b32(secret)).update(c).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
const secret = () => (fs.existsSync(SECRET_FILE) ? fs.readFileSync(SECRET_FILE, 'utf8').trim() : null);

// A TOTP code is single-use: wait for the next 30 s window when the last one was spent.
async function freshCode() {
  const s = secret();
  if (!s) throw new Error(`no TOTP secret at ${SECRET_FILE}; run sh/setup.sh`);
  const last = fs.existsSync(LAST_FILE) ? +fs.readFileSync(LAST_FILE, 'utf8') : 0;
  let w = Math.floor(Date.now() / 30000);
  while (w <= last) {
    await new Promise((r) => setTimeout(r, 1000));
    w = Math.floor(Date.now() / 30000);
  }
  writePrivate(LAST_FILE, String(w));
  return totp(s);
}

async function open(opts = {}) {
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: opts.viewport || { width: 1440, height: 900 },
    storageState: fs.existsSync(STORAGE) ? STORAGE : undefined,
  });
  await context.addInitScript(() => {
    try { localStorage.setItem('breeze-onboarding-complete', 'true'); } catch {}
    window.__toasts = [];
    const start = () => new MutationObserver(() => {
      document.querySelectorAll('[data-testid="toast"]').forEach((t) => {
        const s = t.textContent.trim();
        if (!window.__toasts.includes(s)) window.__toasts.push(s);
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
    if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
  });
  const page = await context.newPage();

  // Virtual platform authenticator (Touch ID stand-in). Credentials persist in .state/passkeys-<user>.json.
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  if (fs.existsSync(PASSKEYS)) {
    for (const c of JSON.parse(fs.readFileSync(PASSKEYS, 'utf8'))) {
      await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: c }).catch((e) => console.error('passkey restore failed: ' + String(e).slice(0, 120)));
    }
  }
  const savePasskeys = async () => {
    try {
      const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
      if (credentials.length) writePrivate(PASSKEYS, JSON.stringify(credentials));
      return credentials.length;
    } catch { return -1; }
  };

  const net = [];
  const errs = [];
  let token = null;
  page.on('response', async (r) => {
    const u = r.url();
    if (!u.includes('/api/') || u.includes('/auth/')) return;
    const m = r.request().method();
    const s = r.status();
    if (m !== 'GET' || s >= 400) {
      let b = '';
      try { b = (await r.text()).slice(0, 300); } catch {}
      net.push({ m, u: u.replace(BASE, '').replace('/api/v1', ''), s, b, t: Date.now() });
    }
  });
  page.on('request', (r) => {
    const a = r.headers().authorization;
    if (a && a.startsWith('Bearer ey') && r.url().includes('/api/')) token = a;
  });
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 240)); });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 240)));

  async function login() {
    await page.goto('/login');
    await page.waitForSelector('[data-testid="login-email-input"]');
    await page.fill('[data-testid="login-email-input"]', cred.email);
    await page.fill('[data-testid="login-password-input"]', cred.password);
    await page.click('[data-testid="login-submit"]');
    if (secret()) {
      await page.waitForSelector('[data-testid="mfa-digit-0"]', { timeout: 15000 }).catch(() => {});
      if (await page.locator('[data-testid="mfa-digit-0"]').count()) {
        const code = await freshCode();
        for (let i = 0; i < 6; i++) await page.fill(`[data-testid="mfa-digit-${i}"]`, code[i]);
        await page.click('[data-testid="mfa-submit"]').catch(() => {});
      }
    }
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 });
  }
  async function go(p) {
    await page.goto(p, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (new URL(page.url()).pathname.startsWith('/login')) {
      await login();
      net.length = 0;
      errs.length = 0;
      await page.goto(p, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await context.storageState({ path: STORAGE });
    fs.chmodSync(STORAGE, 0o600);
  }
  const shotsDir = statePath('shots');
  fs.mkdirSync(shotsDir, { recursive: true, mode: 0o700 });
  const shot = (n, full = false) => page.screenshot({ path: path.join(shotsDir, n + '.png'), fullPage: full }).catch(() => {});
  // Same-origin API call with the page's cookies and the last bearer it used.
  const api = (p, init) => page.evaluate(async ([p, init, tok]) => {
    const h = Object.assign({ 'content-type': 'application/json' }, tok ? { authorization: tok } : {}, (init && init.headers) || {});
    const r = await fetch('/api/v1' + p, Object.assign({ credentials: 'include' }, init || {}, { headers: h, body: init && init.body ? JSON.stringify(init.body) : undefined }));
    const t = await r.text();
    let j;
    try { j = JSON.parse(t); } catch {}
    return { status: r.status, body: j ?? t.slice(0, 2000) };
  }, [p, init, token]);
  const toasts = () => page.evaluate(() => window.__toasts || []);
  const text = (sel = 'main') => page.evaluate((s) => (document.querySelector(s) || document.body).innerText, sel);
  async function close() {
    await savePasskeys();
    await context.storageState({ path: STORAGE }).catch(() => {});
    if (fs.existsSync(STORAGE)) fs.chmodSync(STORAGE, 0o600);
    await browser.close();
  }
  return { browser, context, page, net, errs, login, go, shot, api, toasts, text, close, freshCode, savePasskeys, token: () => token, BASE, STATE_DIR };
}

module.exports = { open, totp, secret, freshCode, BASE, HERE, ROOT, STATE_DIR, DESCRIPTOR, stack, statePath, writePrivate, USER };
