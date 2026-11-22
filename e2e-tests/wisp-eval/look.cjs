// node look.cjs <path> <tag> [maxChars] — open a page, run optional steps, print its text, save a screenshot.
// env STEPS: JSON array of [action, selectorOrValue, value?]; actions:
//   click, fill, type, press, select, check, wait <ms>, totp <selector> (fills a fresh TOTP code),
//   text <selector> (print it), shot <name>
// env SEL=<css> (text root, default main), TAIL=1 (print the end), IDS=1 (list test ids), VW=<px> (viewport width)
// env STRICT=1: exit 1 when a step fails (setup scripts use this).
const { open } = require('./lib.cjs');

async function runSteps(s, steps) {
  const page = s.page;
  const failures = [];
  for (const [a, x, v] of steps) {
    try {
      if (a === 'click') await page.locator(x).first().click({ timeout: 8000 });
      else if (a === 'fill') await page.locator(x).first().fill(v, { timeout: 8000 });
      else if (a === 'type') await page.locator(x).first().pressSequentially(v, { delay: 20 });
      else if (a === 'press') await page.keyboard.press(x);
      else if (a === 'select') await page.locator(x).first().selectOption(v, { timeout: 8000 });
      else if (a === 'check') await page.locator(x).first().check({ timeout: 8000 });
      else if (a === 'wait') await page.waitForTimeout(+x);
      else if (a === 'totp') { const code = await s.freshCode(); await page.locator(x).first().fill(code, { timeout: 8000 }); }
      else if (a === 'text') console.log(`TEXT ${x}: ` + (await page.locator(x).first().innerText({ timeout: 8000 })).replace(/\n+/g, ' | ').slice(0, 1200));
      else if (a === 'shot') await s.shot(x);
      else throw new Error(`unknown step action ${a}`);
      await page.waitForTimeout(500);
    } catch (e) {
      const msg = `STEP FAIL ${a} ${x}: ${String(e).split('\n')[0].slice(0, 200)}`;
      console.log(msg);
      failures.push(msg);
    }
  }
  return failures;
}

module.exports = { runSteps };

if (require.main === module) {
  const [p, tag = 'look', max = '2500'] = process.argv.slice(2);
  if (!p) { console.error('usage: node look.cjs <path> <tag> [maxChars]'); process.exit(2); }
  (async () => {
    const s = await open(process.env.VW ? { viewport: { width: +process.env.VW, height: 900 } } : {});
    const page = s.page;
    let failures = [];
    try {
      await s.go(p);
      failures = await runSteps(s, process.env.STEPS ? JSON.parse(process.env.STEPS) : []);
      await page.waitForTimeout(800);
      console.log('URL ' + page.url().replace(s.BASE, ''));
      const full = (await s.text(process.env.SEL || 'main')).replace(/\n{2,}/g, '\n');
      console.log('TEXT:\n' + (process.env.TAIL ? full.slice(-(+max)) : full.slice(0, +max)));
      if (process.env.IDS) console.log('TESTIDS ' + (await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')))].join(' '))).slice(0, 2500));
      const net = s.net.map((n) => `${n.m} ${n.u.slice(0, 80)} ${n.s}${n.s >= 400 ? ' ' + n.b.slice(0, 200) : ''}`);
      if (net.length) console.log('NET ' + JSON.stringify(net));
      const t = await s.toasts();
      if (t.length) console.log('TOASTS ' + JSON.stringify(t));
      const errs = s.errs.filter((e) => !e.includes('401'));
      if (errs.length) console.log('ERRS ' + JSON.stringify(errs.slice(0, 4)));
      await s.shot(tag);
    } finally {
      await s.close();
    }
    if (process.env.STRICT && failures.length) process.exit(1);
  })().catch((e) => { console.error('SCRIPT ERR', String(e).slice(0, 500)); process.exit(1); });
}
