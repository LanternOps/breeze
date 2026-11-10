// Send one Wisp chat turn in a real browser and return what the technician saw.
//
// Library:  const { openDoor, sendTurn } = require('./turn.cjs')
//           const r = await sendTurn(session, { text, approve: 'approve'|'deny'|'none', maxSec, tag, door })
// CLI:      node turn.cjs <tag> <approve|deny|none> <maxSec> <prompt...>
//           env PATHX=/devices/<id> PANE=1   send from the pane on that page instead of /wisp
//           env JSON=1                        print the structured result as JSON
const fs = require('fs');
const path = require('path');
const { open, statePath } = require('./lib.cjs');

// Test ids whose first appearance during a turn is recorded (with the text they showed).
const WATCH = [
  'ai-thinking-indicator', 'ai-thinking-approval-wait', 'wisp-check-in-chip', 'wisp-instruction-chip',
  'wisp-budget-warning', 'approval-standing-instruction-banner',
];
// Error banners above the composer: /wisp has a test id; the pane banner does not, so match its classes.
const BANNERS = ['[data-testid="wisp-home-thread-error"]', '[data-testid="ai-chat-sidebar"] div.border-red-800\\/50'];
// Exact text: has-text("Approve") also matches the "Approved" buttons of decided cards and loops forever.
// Buttons already on the page before the turn (an earlier run's card still awaiting approval in the
// thread history) are tagged data-wisp-eval-old and ignored: this turn acts only on its own cards.
const APPROVE = (root) => `${root} button:text-is("Approve"):not([disabled]):not([data-wisp-eval-old])`;

const threadSelector = (door) => (door === 'pane' ? '[data-testid="ai-chat-sidebar"]' : '[data-testid="wisp-home-thread"]');

// Navigate to the door and wait for the composer. door 'wisp' = /wisp; 'pane' = the assistant pane on `panePath`.
async function openDoor(s, { door = 'wisp', panePath } = {}) {
  const p = s.page;
  await s.go(door === 'pane' ? panePath : '/wisp');
  if (door === 'pane') {
    await p.waitForTimeout(1500);
    const visible = await p.evaluate(() => {
      const e = document.querySelector('[data-testid="ai-chat-sidebar"]');
      if (!e) return false;
      const r = e.getBoundingClientRect();
      return r.width > 50 && r.left < window.innerWidth - 50 && r.right > 50;
    });
    if (!visible) await p.click('[data-testid="ai-assistant-toggle"]');
    await p.waitForTimeout(2500);
  }
  await p.waitForSelector('[data-testid="ai-chat-input"]', { state: 'visible', timeout: 30000 });
  await p.waitForTimeout(1500);
}

async function installWatchers(p) {
  await p.evaluate(([ids, banners]) => {
    clearInterval(window.__watchTimer);
    window.__seen = {};
    window.__banners = [];
    window.__watchTimer = setInterval(() => {
      for (const id of ids) {
        const e = document.querySelector(`[data-testid="${id}"]`);
        if (e && !window.__seen[id]) window.__seen[id] = { t: Date.now(), text: e.innerText.replace(/\s+/g, ' ').slice(0, 200) };
      }
      for (const sel of banners) {
        for (const e of document.querySelectorAll(sel)) {
          const t = e.innerText.replace(/\s+/g, ' ').trim();
          if (t && !window.__banners.includes(t)) window.__banners.push(t);
        }
      }
    }, 200);
  }, [WATCH, BANNERS]);
}

async function fillAndSend(p, text) {
  for (let i = 0; i < 12; i++) {
    await p.fill('[data-testid="ai-chat-input"]', text);
    await p.waitForTimeout(600);
    if (!(await p.locator('[data-testid="ai-chat-send"]').first().isDisabled())) break;
    await p.waitForTimeout(1000);
  }
  await p.click('[data-testid="ai-chat-send"]');
}

async function tagOldButtons(p) {
  await p.evaluate(() => {
    for (const b of document.querySelectorAll('button')) if (['Approve', 'Deny'].includes(b.innerText.trim())) b.setAttribute('data-wisp-eval-old', '1');
  });
}

// Text of the first new card, which is also tagged data-wisp-eval-card so Deny can be scoped to it.
async function cardText(p) {
  return p.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Approve' && !x.disabled && !x.hasAttribute('data-wisp-eval-old'));
    if (!b) return null;
    let n = b;
    for (let i = 0; i < 8 && n.parentElement; i++) {
      n = n.parentElement;
      if (/Approval/i.test(n.innerText) && n.innerText.length > 60) break;
    }
    document.querySelectorAll('[data-wisp-eval-card]').forEach((e) => e.removeAttribute('data-wisp-eval-card'));
    n.setAttribute('data-wisp-eval-card', '1');
    return n.innerText.replace(/\n+/g, ' | ').slice(0, 1500);
  });
}

// Everything the thread shows after this turn's user message.
async function replyAfter(p, door, text) {
  return p.evaluate(([sel, q]) => {
    const th = document.querySelector(sel) || document.querySelector('main') || document.body;
    const t = th.innerText;
    const key = q.slice(0, 60);
    const i = t.lastIndexOf(key);
    if (i < 0) return t.slice(-3000).trim();
    const full = t.indexOf(q, i);
    return t.slice(full === i ? i + q.length : i + key.length).trim();
  }, [threadSelector(door), text]);
}

/**
 * Send one turn on an open session (the composer must be visible: call openDoor first).
 * opts: { text, approve: 'approve'|'deny'|'none', maxSec, tag, door, stopAfterSec }
 * stopAfterSec: press Stop that many seconds after the reply starts streaming.
 */
async function sendTurn(s, opts) {
  const { text, approve = 'none', maxSec = 90, tag = 'turn', door = 'wisp', stopAfterSec } = opts;
  const p = s.page;
  const netStart = s.net.length;
  const errStart = s.errs.length;
  await installWatchers(p);
  await tagOldButtons(p);
  const startedAt = new Date();
  const t0 = Date.now();
  await fillAndSend(p, text);

  let handled = 0;
  let stopped = null;
  const cards = [];
  const root = threadSelector(door);
  if (stopAfterSec !== undefined) {
    const appeared = await p.waitForSelector('[data-testid="ai-chat-stop"]', { timeout: 15000 }).then(() => true).catch(() => false);
    if (appeared) {
      await p.waitForTimeout(stopAfterSec * 1000);
      if (await p.locator('[data-testid="ai-chat-stop"]').count()) {
        await p.click('[data-testid="ai-chat-stop"]').catch(() => {});
        stopped = ((Date.now() - t0) / 1000).toFixed(1);
      }
    }
  }
  while (Date.now() - t0 < maxSec * 1000) {
    await p.waitForTimeout(700);
    const ab = p.locator(`${APPROVE(root)}, ${APPROVE('main')}`);
    if (await ab.count()) {
      await p.waitForTimeout(1200);
      const card = await cardText(p);
      if (card && !cards.includes(card)) {
        cards.push(card);
        await s.shot(`${tag}-approval${cards.length}`);
      }
      if (approve === 'approve') {
        await ab.first().click();
        handled++;
      } else if (approve === 'deny') {
        const scoped = p.locator('[data-wisp-eval-card] button:text-is("Deny")');
        await ((await scoped.count()) ? scoped : p.locator('button:text-is("Deny"):not([data-wisp-eval-old])')).first().click();
        handled++;
        await p.waitForTimeout(800);
        const c = p.locator('button:has-text("Confirm"), button:has-text("Deny action")');
        if (await c.count()) await c.first().click().catch(() => {});
      } else {
        break;
      }
      await p.waitForTimeout(1500);
      continue;
    }
    const streaming = await p.locator('[data-testid="ai-chat-stop"]').count();
    if (!streaming && Date.now() - t0 > 4000) {
      await p.waitForTimeout(1500);
      if (!(await p.locator('[data-testid="ai-chat-stop"]').count())) break;
    }
  }
  const elapsedSec = +((Date.now() - t0) / 1000).toFixed(1);
  await p.waitForTimeout(1000);
  const stillStreaming = (await p.locator('[data-testid="ai-chat-stop"]').count()) > 0;
  const { seen, banners } = await p.evaluate((t0) => ({
    seen: Object.fromEntries(Object.entries(window.__seen || {}).map(([k, v]) => [k, { atSec: +((v.t - t0) / 1000).toFixed(1), text: v.text }])),
    banners: window.__banners || [],
  }), t0);
  const reply = await replyAfter(p, door, text);
  const meter = await p.evaluate(() => document.querySelector('[data-testid="wisp-spend-meter"]')?.innerText.replace(/\n/g, ' ') || null);
  const net = s.net.slice(netStart).filter((n) => !n.u.includes('ws-ticket'));
  const errors = [
    ...net.filter((n) => n.s >= 400).map((n) => `${n.m} ${n.u.slice(0, 90)} ${n.s} ${n.b.slice(0, 160)}`),
    ...s.errs.slice(errStart).filter((e) => !e.includes('401')),
  ];
  const toasts = await s.toasts();
  await s.shot(tag);
  fs.appendFileSync(statePath('turns.log'), `${startedAt.toISOString()}\t${tag}\t${approve}\t${elapsedSec}s\t${text.replace(/\s+/g, ' ')}\n`, { mode: 0o600 });
  return {
    tag, text, startedAt: startedAt.toISOString(), elapsedSec, approvalsHandled: handled, stillStreaming, stoppedAtSec: stopped,
    cards, chips: Object.values(seen).map((v) => v.text), seen, banners, reply, meter, toasts, errors,
    net: net.map((n) => `${n.m} ${n.u.slice(0, 90)} ${n.s}`),
  };
}

function printTurn(r) {
  console.log(`[${r.tag}] elapsed ${r.elapsedSec}s · approvals handled ${r.approvalsHandled} · still streaming ${r.stillStreaming}${r.stoppedAtSec ? ` · stopped at ${r.stoppedAtSec}s` : ''}`);
  for (const c of r.cards) console.log('APPROVAL CARD: ' + c);
  if (Object.keys(r.seen).length) console.log('SEEN ' + JSON.stringify(r.seen));
  if (r.banners.length) console.log('BANNERS ' + JSON.stringify(r.banners));
  console.log('REPLY:\n' + r.reply.slice(0, +(process.env.MAXOUT || 3200)));
  console.log('METER ' + r.meter);
  if (r.net.length) console.log('NET ' + JSON.stringify(r.net));
  if (r.toasts.length) console.log('TOASTS ' + JSON.stringify(r.toasts));
  if (r.errors.length) console.log('ERRS ' + JSON.stringify(r.errors.slice(0, 6)));
}

module.exports = { openDoor, sendTurn, printTurn, threadSelector, WATCH };

if (require.main === module) {
  const [tag, approve, maxSec, ...rest] = process.argv.slice(2);
  const text = rest.join(' ');
  if (!tag || !['approve', 'deny', 'none'].includes(approve) || !(+maxSec > 0) || !text) {
    console.error('usage: node turn.cjs <tag> <approve|deny|none> <maxSec> <prompt...>   [env PATHX=/path PANE=1 JSON=1]');
    process.exit(2);
  }
  (async () => {
    const s = await open();
    const door = process.env.PANE ? 'pane' : 'wisp';
    try {
      await openDoor(s, { door, panePath: process.env.PATHX || '/' });
      const r = await sendTurn(s, { text, approve, maxSec: +maxSec, tag, door });
      if (process.env.JSON) console.log(JSON.stringify(r, null, 2)); else printTurn(r);
    } finally {
      await s.close();
    }
  })().catch((e) => { console.error('SCRIPT ERR', String(e).slice(0, 600)); process.exit(1); });
}
