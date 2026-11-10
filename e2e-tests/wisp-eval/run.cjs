#!/usr/bin/env node
// Wisp scenario benchmark. Drives each scenario in a real browser against the local
// stack, collects what Wisp did from the page and the database, scores it with
// score.cjs (code checks only, no model judge) and writes a report.
//
//   node run.cjs                     every scenario in scenarios/*.json
//   node run.cjs --only a,b          just these ids
//   node run.cjs --no-reset          skip sh/reset.sh between scenarios
//   node run.cjs --list              validate and list the scenarios, run nothing
//
// env WISP_EVAL_TURN_CAP (default 100): refuse to start a scenario once the stack has
//   seen this many model turns (user messages + agent runs) in total.
//
// Exit code: 1 when any scenario lands in UNEXPECTED FAIL (a regression, an
// inconclusive run, or a harness error); 0 otherwise.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { scoreScenario, bucketFor, summarize, validateScenario, markdownTable, countWords, TEMPLATE } = require('./score.cjs');

const HERE = __dirname;
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

function loadScenarios() {
  const dir = path.join(HERE, 'scenarios');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const list = files.map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
  const errs = list.flatMap(validateScenario);
  const ids = new Set();
  for (const s of list) { if (ids.has(s.id)) errs.push(`duplicate scenario id ${s.id}`); ids.add(s.id); }
  if (errs.length) { console.error(errs.join('\n')); process.exit(2); }
  const only = opt('--only');
  return only ? list.filter((s) => only.split(',').includes(s.id)) : list;
}

const scenarios = loadScenarios();
if (flag('--list')) {
  for (const s of scenarios) console.log(`${s.id.padEnd(34)} ${s.expect.padEnd(10)} ${s.issue ? '#' + s.issue : ''}  ${s.title}`);
  process.exit(0);
}

const lib = require('./lib.cjs');
const { openDoor, sendTurn } = require('./turn.cjs');
const PG = lib.stack.pgContainer;

// --- database helpers (psql in the stack's postgres container, superuser) ---
function psql(sql) {
  const r = spawnSync('docker', ['exec', '-i', PG, 'psql', '-U', 'breeze', '-d', 'breeze', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || '').trim().slice(0, 300)} :: ${sql.slice(0, 200)}`);
  return r.stdout.replace(/\n$/, '');
}
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const rows = (sql) => JSON.parse(psql(`select coalesce(json_agg(t), '[]') from (${sql}) t`) || '[]');
const dbNow = () => psql("select to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')");

function expand(text, ctx) {
  return String(text).replace(TEMPLATE, (_, name) => {
    if (name === 'since') return `${lit(ctx.since)}::timestamptz`;
    const [kind, ...rest] = name.split(':');
    const key = rest.join(':');
    const sql = kind === 'device'
      ? `select id from devices where display_name = ${lit(key)} order by enrolled_at desc nulls last limit 1`
      : `select id from organizations where name = ${lit(key)} and deleted_at is null limit 1`;
    const id = psql(sql);
    if (!id) throw new Error(`template ${name}: not found`);
    return id;
  });
}

const spend = () => +psql("select coalesce(sum(total_cost_cents), 0) from ai_cost_usage where period = 'daily'");
const turnsSoFar = () => +psql("select (select count(*) from ai_messages where role = 'user') + (select count(*) from ai_agent_runs)");

function sh(argv) {
  const [script, ...rest] = argv;
  if (!/^[a-z0-9-]+\.sh$/.test(script)) throw new Error(`shell step: ${script} is not a harness script`);
  const r = spawnSync('bash', [path.join(HERE, 'sh', script), ...rest], { encoding: 'utf8', env: { ...process.env, BREEZE_STACK_DESCRIPTOR: lib.DESCRIPTOR } });
  return { exit: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim().slice(-600) };
}

async function waitSql(sql, equals, timeoutSec) {
  const t0 = Date.now();
  let v = null;
  while (Date.now() - t0 < timeoutSec * 1000) {
    v = psql(sql);
    if (String(v) === String(equals)) return { ok: true, value: v, afterSec: +((Date.now() - t0) / 1000).toFixed(1) };
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: false, value: v, afterSec: timeoutSec };
}

async function runScenario(sc) {
  const started = Date.now();
  const ctx = { since: dbNow() };
  const costBefore = spend();
  const observed = { steps: {}, tools: [], sql: {}, error: null };
  const windows = [];
  const notes = [];
  let door = sc.door;
  const s = await lib.open();
  try {
    await openDoor(s, { door, panePath: sc.panePath ? expand(sc.panePath, ctx) : undefined });
    for (const [i, st] of sc.steps.entries()) {
      const name = st.name || `${st.type}-${i}`;
      const from = dbNow();
      if (st.type === 'say' || st.type === 'stop_stream') {
        const r = await sendTurn(s, {
          text: expand(st.text, ctx), approve: st.approve || 'none', maxSec: st.maxSec || 90,
          tag: `${sc.id}-${name}`, door, stopAfterSec: st.type === 'stop_stream' ? (st.afterSec ?? 3) : undefined,
        });
        if (st.type === 'stop_stream' && !r.stoppedAtSec) throw new Error(`step ${name}: the reply ended before Stop could be pressed`);
        if (r.stillStreaming) notes.push(`step ${name}: still streaming after ${st.maxSec || 90}s`);
        observed.steps[name] = { kind: st.type, reply: r.reply, cards: r.cards, chips: r.chips, banners: r.banners, errors: r.errors, elapsedSec: r.elapsedSec };
      } else if (st.type === 'wait_sql') {
        const w = await waitSql(expand(st.sql, ctx), st.equals, st.timeoutSec || 60);
        observed.steps[name] = { kind: 'wait_sql', ...w };
        if (!w.ok) notes.push(`step ${name}: wait_sql timed out at ${w.value}`);
        if (!w.ok && st.required) throw new Error(`step ${name}: required wait_sql timed out (last value ${w.value})`);
      } else if (st.type === 'shell') {
        const r = sh(st.argv);
        observed.steps[name] = { kind: 'shell', ...r };
        if (r.exit !== 0) throw new Error(`step ${name}: ${st.argv.join(' ')} exited ${r.exit}: ${r.out}`);
      } else if (st.type === 'open') {
        door = st.door || 'wisp';
        await openDoor(s, { door, panePath: st.path ? expand(st.path, ctx) : undefined });
        observed.steps[name] = { kind: 'open', door, url: s.page.url().replace(s.BASE, '') };
      } else if (st.type === 'sleep') {
        await s.page.waitForTimeout((st.sec || 1) * 1000);
        observed.steps[name] = { kind: 'sleep' };
      }
      windows.push({ name, from, to: dbNow(), say: st.type === 'say' || st.type === 'stop_stream' });
    }
  } catch (e) {
    observed.error = String(e.message || e).slice(0, 500);
  } finally {
    await s.close().catch(() => {});
  }
  // Let late writes land (tool rows settle, posts, cost rows).
  await new Promise((r) => setTimeout(r, 3000));

  // What the model really did: tool rows and assistant text, attributed to the step whose window holds them.
  const stepOf = (at) => (windows.find((w) => at >= w.from && at <= w.to) || {}).name || null;
  const toolRows = rows(`select to_char(e.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at, e.tool_name, e.status::text as status, e.tool_input::text as input,
                                case when exists (select 1 from ai_agent_runs r where r.session_id = e.session_id) or s.agent_id is not null then 'run' else 'chat' end as origin
                         from ai_tool_executions e left join ai_sessions s on s.id = e.session_id
                         where e.created_at >= ${lit(ctx.since)}::timestamptz order by e.created_at`);
  observed.tools = toolRows.map((t) => ({ step: stepOf(t.at), tool: t.tool_name, status: t.status, input: t.input, origin: t.origin }));
  const msgRows = rows(`select to_char(m.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at, m.role::text as role, coalesce(m.content, '') as content
                        from ai_messages m where m.created_at >= ${lit(ctx.since)}::timestamptz and m.role in ('assistant', 'user') order by m.created_at`);
  for (const w of windows.filter((x) => x.say)) {
    const st = observed.steps[w.name];
    if (st) st.assistantText = msgRows.filter((m) => m.role === 'assistant' && stepOf(m.at) === w.name).map((m) => m.content).join('\n\n');
  }
  for (const c of sc.checks.filter((x) => x.kind === 'sql_equals')) {
    try { observed.sql[c.sql] = psql(expand(c.sql, ctx)); } catch (e) { notes.push(`sql check failed to run: ${e.message}`); }
  }
  const runs = rows(`select count(*)::int as n from ai_agent_runs where queued_at >= ${lit(ctx.since)}::timestamptz`)[0].n;

  const score = scoreScenario(sc, observed);
  const runError = observed.error || (score.inconclusive ? 'precondition failed (inconclusive)' : null);
  const bucket = bucketFor(sc.expect, score.passed, runError);
  return {
    id: sc.id, title: sc.title, issue: sc.issue || null, expect: sc.expect, bucket, passed: score.passed,
    error: runError, checks: score.checks, notes,
    toolCalls: observed.tools.length,
    tools: observed.tools.map((t) => `${t.step || '-'}:${t.origin}:${t.tool}:${t.status}`),
    words: Object.values(observed.steps).reduce((a, st) => a + countWords(st.assistantText), 0),
    userTurns: msgRows.filter((m) => m.role === 'user').length,
    agentRuns: runs,
    wallSec: +((Date.now() - started) / 1000).toFixed(1),
    costCents: +(spend() - costBefore).toFixed(3),
    steps: Object.fromEntries(Object.entries(observed.steps).map(([k, v]) => [k, { ...v, reply: v.reply ? v.reply.slice(0, 2000) : v.reply }])),
    // The full scoring input, so a check can be re-scored offline (rescore.cjs) without new model turns.
    observed,
  };
}

(async () => {
  const cap = +(process.env.WISP_EVAL_TURN_CAP || 100);
  const results = [];
  const startedAt = new Date().toISOString();
  const spendStart = spend();
  const turnsStart = turnsSoFar();
  for (const sc of scenarios) {
    const used = turnsSoFar();
    if (used >= cap) {
      console.error(`turn cap reached (${used} >= WISP_EVAL_TURN_CAP=${cap}); stopping before ${sc.id}`);
      break;
    }
    if (!flag('--no-reset')) {
      const r = sh(['reset.sh']);
      if (r.exit !== 0) { console.error(`reset failed before ${sc.id}: ${r.out}`); process.exit(1); }
    }
    process.stderr.write(`▶ ${sc.id} (${sc.expect}) … `);
    let res;
    try {
      res = await runScenario(sc);
    } catch (e) {
      res = { id: sc.id, title: sc.title, issue: sc.issue || null, expect: sc.expect, bucket: 'unexpected-fail', passed: false, error: 'harness: ' + String(e.message || e).slice(0, 400), checks: [], notes: [] };
    }
    results.push(res);
    process.stderr.write(`${res.bucket}${res.error ? ' — ' + res.error : ''}\n`);
  }
  const summary = summarize(results);
  summary.spendCentsTotal = +(spend() - spendStart).toFixed(3);
  summary.modelTurnsUsed = turnsSoFar() - turnsStart;
  const report = { startedAt, finishedAt: new Date().toISOString(), stack: lib.stack.project, baseUrl: lib.BASE, results, summary };
  const dir = lib.statePath('reports');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `run-${startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });

  console.log(markdownTable(report));
  console.log(`\nspend this run: $${(summary.spendCentsTotal / 100).toFixed(3)} (ai_cost_usage delta, includes background assessments) · model turns: ${summary.modelTurnsUsed}`);
  for (const r of results.filter((x) => x.bucket !== 'pass')) {
    console.log(`\n### ${r.id} — ${r.bucket}${r.issue ? ` (#${r.issue})` : ''}${r.error ? `\n${r.error}` : ''}`);
    for (const c of r.checks || []) console.log(`- ${c.ok ? 'ok  ' : 'FAIL'} ${c.precondition ? '[pre] ' : ''}${c.kind}${c.step ? ` @${c.step}` : ''}: expected ${c.expected ?? '-'}; observed ${typeof c.observed === 'string' ? c.observed.slice(0, 220) : c.observed}${c.detail ? ` (${c.detail})` : ''}`);
    for (const n of r.notes || []) console.log(`- note: ${n}`);
  }
  console.log(`\nreport: ${file}`);
  process.exit(summary.exitCode);
})().catch((e) => { console.error('RUNNER ERROR', e); process.exit(1); });
