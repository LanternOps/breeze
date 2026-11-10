// Pure scoring for the Wisp scenario benchmark: no I/O, no clock, no model.
// run.cjs collects an `observed` record per scenario and hands it here.
//
// observed = {
//   steps: { <stepName>: { kind, reply, assistantText, cards[], chips[], banners[], errors[] } },
//   tools: [{ step, tool, status, input }],   // ai_tool_executions rows created during the scenario
//   sql:   { <sql text>: <first column of the first row, as text> },
//   error: null | '<runner error>'
// }

const EXPECTS = ['pass', 'known-red'];
const DOORS = ['wisp', 'pane'];
const STEP_TYPES = ['say', 'wait_sql', 'shell', 'open', 'stop_stream', 'sleep'];
const APPROVE_MODES = ['approve', 'deny', 'none'];
const CHECK_KINDS = [
  'reply_matches', 'reply_not_matches', 'card_matches', 'card_not_matches',
  'tool_called', 'tool_not_called', 'max_tool_calls', 'sql_equals', 'max_words', 'no_error_banner',
];
const BUCKETS = ['pass', 'known-red', 'unexpected-fail', 'unexpected-pass'];

function countWords(text) {
  if (!text) return 0;
  const t = String(text).trim();
  return t ? t.split(/\s+/).length : 0;
}

const clip = (s, n = 300) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

function compile(pattern, flags) {
  return new RegExp(pattern, flags || '');
}

// Tool rows filtered by step, tool name, status (anchored regex) and input (regex).
function matchTools(check, tools) {
  const status = check.status ? new RegExp(`^(?:${check.status})$`) : null;
  const input = check.inputMatches ? new RegExp(check.inputMatches) : null;
  return (tools || []).filter((t) =>
    (!check.step || t.step === check.step) &&
    (!check.tool || t.tool === check.tool) &&
    (!status || status.test(t.status || '')) &&
    (!input || input.test(t.input || '')));
}

const describeTools = (rows) => rows.map((t) => `${t.tool}:${t.status}`).join(', ') || '(none)';

function stepTexts(observed, step, field) {
  const steps = observed.steps || {};
  if (step) return steps[step] ? [steps[step][field]] : null;
  return Object.values(steps).map((s) => s[field]);
}

function evaluateCheck(check, observed) {
  const base = { kind: check.kind, step: check.step || null, expected: null, observed: null, ok: false, detail: '' };
  try {
    switch (check.kind) {
      case 'reply_matches':
      case 'reply_not_matches': {
        const s = (observed.steps || {})[check.step];
        if (!s) return { ...base, detail: `no observed step "${check.step}"` };
        const hit = compile(check.pattern, check.flags).test(s.reply || '');
        const want = check.kind === 'reply_matches';
        return { ...base, expected: `${want ? '' : 'not '}/${check.pattern}/${check.flags || ''}`, observed: clip(s.reply), ok: hit === want };
      }
      case 'card_matches':
      case 'card_not_matches': {
        const s = (observed.steps || {})[check.step];
        if (!s) return { ...base, detail: `no observed step "${check.step}"` };
        const re = compile(check.pattern, check.flags);
        const cards = s.cards || [];
        const any = cards.some((c) => re.test(c));
        const want = check.kind === 'card_matches';
        return { ...base, expected: `${want ? 'a card matching' : 'no card matching'} /${check.pattern}/`, observed: cards.length ? cards.map((c) => clip(c, 160)).join(' || ') : '(no card)', ok: any === want };
      }
      case 'tool_called':
      case 'tool_not_called': {
        const rows = matchTools(check, observed.tools);
        const want = check.kind === 'tool_called';
        const label = [check.tool, check.status && `status ${check.status}`, check.inputMatches && `input /${check.inputMatches}/`, check.step && `in ${check.step}`].filter(Boolean).join(', ');
        return { ...base, expected: `${want ? '' : 'no '}call: ${label}`, observed: describeTools(rows), ok: want ? rows.length > 0 : rows.length === 0 };
      }
      case 'max_tool_calls': {
        const n = matchTools({ step: check.step, tool: check.tool }, observed.tools).length;
        return { ...base, expected: `<= ${check.max}`, observed: n, ok: n <= check.max };
      }
      case 'sql_equals': {
        const sql = observed.sql || {};
        if (!Object.prototype.hasOwnProperty.call(sql, check.sql)) return { ...base, expected: check.equals, detail: 'query was not run' };
        const v = sql[check.sql];
        return { ...base, expected: check.equals, observed: v, ok: String(v) === String(check.equals) };
      }
      case 'max_words': {
        const texts = stepTexts(observed, check.step, 'assistantText');
        if (!texts) return { ...base, detail: `no observed step "${check.step}"` };
        const n = texts.reduce((a, t) => a + countWords(t), 0);
        return { ...base, expected: `<= ${check.max}`, observed: n, ok: n <= check.max };
      }
      case 'no_error_banner': {
        const lists = stepTexts(observed, check.step, 'banners');
        if (!lists) return { ...base, detail: `no observed step "${check.step}"` };
        const banners = lists.flatMap((b) => b || []);
        return { ...base, expected: 'no error banner', observed: banners.length ? banners.map((b) => clip(b, 160)).join(' || ') : '(none)', ok: banners.length === 0 };
      }
      default:
        return { ...base, detail: `unknown check kind "${check.kind}"` };
    }
  } catch (e) {
    return { ...base, detail: `check error: ${e.message}` };
  }
}

// A check marked `precondition` guards the scenario's premise (Wisp actually opened the
// ticket, the approval card actually appeared). When one fails the run is inconclusive:
// the other checks prove nothing, and a known-red scenario must not hide that.
function scoreScenario(scenario, observed) {
  const checks = (scenario.checks || []).map((c) => ({ ...evaluateCheck(c, observed), precondition: !!c.precondition, note: c.note || null }));
  const inconclusive = checks.some((c) => c.precondition && !c.ok);
  const passed = !observed.error && !inconclusive && checks.length > 0 && checks.every((c) => c.ok);
  return { passed, inconclusive, checks };
}

function bucketFor(expect, passed, runError) {
  if (runError) return 'unexpected-fail';
  if (expect === 'known-red') return passed ? 'unexpected-pass' : 'known-red';
  return passed ? 'pass' : 'unexpected-fail';
}

function summarize(results) {
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  const totals = { toolCalls: 0, words: 0, wallSec: 0, costCents: 0, userTurns: 0, agentRuns: 0 };
  for (const r of results) {
    counts[r.bucket] = (counts[r.bucket] || 0) + 1;
    for (const k of Object.keys(totals)) if (typeof r[k] === 'number') totals[k] += r[k];
  }
  totals.wallSec = Math.round(totals.wallSec * 10) / 10;
  totals.costCents = Math.round(totals.costCents * 1000) / 1000;
  return { counts, totals, exitCode: counts['unexpected-fail'] > 0 ? 1 : 0 };
}

const dollars = (c) => (typeof c === 'number' ? '$' + (c / 100).toFixed(3) : 'n/a');

function markdownTable(report) {
  const rows = [
    '| scenario | bucket | checks ok | tool calls | words | time (s) | cost |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of report.results) {
    const ok = (r.checks || []).filter((c) => c.ok).length;
    rows.push(`| ${r.id} | ${r.bucket} | ${ok}/${(r.checks || []).length} | ${r.toolCalls ?? 'n/a'} | ${r.words ?? 'n/a'} | ${r.wallSec ?? 'n/a'} | ${dollars(r.costCents)} |`);
  }
  const t = report.summary.totals;
  rows.push(`| **total** | ${Object.entries(report.summary.counts).map(([k, v]) => `${k} ${v}`).join(', ')} | | ${t.toolCalls} | ${t.words} | ${t.wallSec} | ${dollars(t.costCents)} |`);
  return rows.join('\n');
}

// {{since}} = scenario start (timestamptz literal); {{device:NAME}}, {{org:NAME}} = ids by name.
const TEMPLATE = /\{\{([^}]+)\}\}/g;
const templateOk = (name) => name === 'since' || /^(device|org):.+/.test(name);
function templateErrors(where, text) {
  const errs = [];
  for (const m of String(text || '').matchAll(TEMPLATE)) if (!templateOk(m[1])) errs.push(`${where}: unknown template "${m[1]}"`);
  return errs;
}

function validateScenario(s) {
  const errs = [];
  const where = `scenario ${s && s.id ? s.id : '(no id)'}`;
  if (!s || typeof s !== 'object') return [`${where}: not an object`];
  for (const k of ['id', 'title']) if (typeof s[k] !== 'string' || !s[k]) errs.push(`${where}: missing ${k}`);
  if (!EXPECTS.includes(s.expect)) errs.push(`${where}: expect must be one of ${EXPECTS.join('|')}`);
  if (!DOORS.includes(s.door)) errs.push(`${where}: door must be one of ${DOORS.join('|')}`);
  if (s.door === 'pane' && !s.panePath) errs.push(`${where}: door "pane" needs panePath`);
  if (!Array.isArray(s.steps) || !s.steps.length) errs.push(`${where}: steps must be a non-empty array`);
  if (!Array.isArray(s.checks)) errs.push(`${where}: checks must be an array`);
  const names = new Set();
  for (const [i, st] of (s.steps || []).entries()) {
    if (!STEP_TYPES.includes(st.type)) errs.push(`${where}: step ${i} has unknown step type "${st.type}"`);
    if (st.name) {
      if (names.has(st.name)) errs.push(`${where}: duplicate step name "${st.name}"`);
      names.add(st.name);
    }
    if (st.type === 'say') {
      if (!st.name) errs.push(`${where}: say step ${i} needs a name`);
      if (typeof st.text !== 'string' || !st.text) errs.push(`${where}: say step ${i} needs text`);
      if (st.approve !== undefined && !APPROVE_MODES.includes(st.approve)) errs.push(`${where}: step ${i} approve must be ${APPROVE_MODES.join('|')}`);
    }
    if (st.type === 'wait_sql' && (typeof st.sql !== 'string' || st.equals === undefined)) errs.push(`${where}: wait_sql step ${i} needs sql and equals`);
    if (st.type === 'shell' && !Array.isArray(st.argv)) errs.push(`${where}: shell step ${i} needs argv[]`);
    if (st.type === 'open' && st.door === 'pane' && typeof st.path !== 'string') errs.push(`${where}: open step ${i} (pane) needs path`);
    if (st.type === 'open' && st.door !== undefined && !DOORS.includes(st.door)) errs.push(`${where}: open step ${i} door must be ${DOORS.join('|')}`);
  }
  errs.push(...templateErrors(`${where} panePath`, s.panePath));
  for (const [i, st] of (s.steps || []).entries()) for (const k of ['sql', 'path', 'text']) errs.push(...templateErrors(`${where} step ${i}`, st[k]));
  for (const [i, c] of (s.checks || []).entries()) errs.push(...templateErrors(`${where} check ${i}`, c.sql));
  for (const [i, c] of (s.checks || []).entries()) {
    if (!CHECK_KINDS.includes(c.kind)) { errs.push(`${where}: check ${i} has unknown check kind "${c.kind}"`); continue; }
    if (c.step && !names.has(c.step)) errs.push(`${where}: check ${i} refers to unknown step "${c.step}"`);
    if (/^(reply|card)_/.test(c.kind)) {
      if (!c.step) errs.push(`${where}: check ${i} (${c.kind}) needs a step`);
      try { compile(c.pattern, c.flags); } catch { errs.push(`${where}: check ${i} has an invalid regex`); }
    }
    if (/^tool_/.test(c.kind) && !c.tool) errs.push(`${where}: check ${i} (${c.kind}) needs tool`);
    if ((c.kind === 'max_tool_calls' || c.kind === 'max_words') && typeof c.max !== 'number') errs.push(`${where}: check ${i} needs a numeric max`);
    if (c.kind === 'sql_equals' && (typeof c.sql !== 'string' || c.equals === undefined)) errs.push(`${where}: check ${i} needs sql and equals`);
  }
  return errs;
}

module.exports = {
  countWords, evaluateCheck, scoreScenario, bucketFor, summarize, validateScenario, markdownTable,
  CHECK_KINDS, STEP_TYPES, BUCKETS, TEMPLATE,
};
