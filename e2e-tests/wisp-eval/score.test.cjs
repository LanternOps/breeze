// node --test e2e-tests/wisp-eval/score.test.cjs
// Every check kind gets one passing and one failing input; the bucket and
// summary rules are pinned too, because they decide the exit code.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  countWords,
  evaluateCheck,
  scoreScenario,
  bucketFor,
  summarize,
  validateScenario,
  markdownTable,
} = require('./score.cjs');

const observed = {
  steps: {
    ask: {
      kind: 'say',
      reply: 'HL-DC-01 is frozen until Friday. I will not restart it.',
      assistantText: 'HL-DC-01 is frozen until Friday. I will not restart it.',
      cards: ['Post PUBLIC comment on ticket T-2026-0001 · We will be on site at 9am'],
      chips: ['Wisp will check back at 3:30 PM'],
      banners: [],
      errors: [],
    },
    stop: {
      kind: 'say',
      reply: 'Here is step one',
      assistantText: 'Here is step one',
      cards: [],
      chips: [],
      banners: ['An internal error occurred. Please try again.'],
      errors: [],
    },
  },
  tools: [
    { step: 'ask', tool: 'manage_tickets', status: 'completed', input: '{"action":"get","ticketId":"x"}' },
    { step: 'ask', tool: 'execute_command', status: 'refused', input: '{"commandType":"restart_service"}' },
    { step: 'stop', tool: 'manage_alerts', status: 'completed', input: '{"action":"list"}' },
  ],
  sql: { "select status from alerts where title = 'x'": 'active' },
};

const check = (c) => evaluateCheck(c, observed);

test('countWords counts whitespace-separated words and ignores empty input', () => {
  assert.equal(countWords('one two  three\nfour'), 4);
  assert.equal(countWords(''), 0);
  assert.equal(countWords(null), 0);
});

test('reply_matches', () => {
  assert.equal(check({ kind: 'reply_matches', step: 'ask', pattern: 'frozen' }).ok, true);
  const r = check({ kind: 'reply_matches', step: 'ask', pattern: 'restarted', flags: 'i' });
  assert.equal(r.ok, false);
  assert.match(r.observed, /HL-DC-01 is frozen/);
});

test('reply_not_matches', () => {
  assert.equal(check({ kind: 'reply_not_matches', step: 'ask', pattern: 'restarted' }).ok, true);
  const r = check({ kind: 'reply_not_matches', step: 'ask', pattern: 'FROZEN', flags: 'i' });
  assert.equal(r.ok, false);
  assert.match(r.observed, /frozen/);
});

test('reply checks on a missing step fail instead of passing vacuously', () => {
  assert.equal(check({ kind: 'reply_not_matches', step: 'nope', pattern: 'x' }).ok, false);
  assert.equal(check({ kind: 'reply_matches', step: 'nope', pattern: '' }).ok, false);
});

test('card_matches', () => {
  assert.equal(check({ kind: 'card_matches', step: 'ask', pattern: 'T-\\d{4}-\\d+' }).ok, true);
  assert.equal(check({ kind: 'card_matches', step: 'stop', pattern: '.' }).ok, false, 'no card at all is a fail');
  assert.equal(check({ kind: 'card_matches', step: 'ask', pattern: '#[0-9a-f]{8}\\.\\.\\.' }).ok, false);
});

test('card_not_matches', () => {
  assert.equal(check({ kind: 'card_not_matches', step: 'ask', pattern: '#[0-9a-f]{8}\\.\\.\\.' }).ok, true);
  assert.equal(check({ kind: 'card_not_matches', step: 'ask', pattern: 'PUBLIC' }).ok, false);
});

test('tool_called with and without step, status and input filters', () => {
  assert.equal(check({ kind: 'tool_called', tool: 'execute_command' }).ok, true);
  assert.equal(check({ kind: 'tool_called', tool: 'execute_command', status: 'refused', step: 'ask' }).ok, true);
  assert.equal(check({ kind: 'tool_called', tool: 'execute_command', status: 'completed' }).ok, false);
  assert.equal(check({ kind: 'tool_called', tool: 'manage_alerts', step: 'ask' }).ok, false);
  assert.equal(check({ kind: 'tool_called', tool: 'manage_tickets', inputMatches: '"action":"get"' }).ok, true);
  assert.equal(check({ kind: 'tool_called', tool: 'launch_specialist' }).ok, false);
});

test('tool_not_called', () => {
  assert.equal(check({ kind: 'tool_not_called', tool: 'run_script' }).ok, true);
  assert.equal(check({ kind: 'tool_not_called', tool: 'manage_tickets', inputMatches: '"action":"(comment|resolve|update)"' }).ok, true);
  assert.equal(check({ kind: 'tool_not_called', tool: 'execute_command', status: 'completed' }).ok, true);
  const r = check({ kind: 'tool_not_called', tool: 'execute_command' });
  assert.equal(r.ok, false);
  assert.match(r.observed, /execute_command:refused/);
  assert.equal(check({ kind: 'tool_not_called', tool: 'manage_tickets', inputMatches: '"action":"get"' }).ok, false);
});

test('status filter is an anchored regex so "complete" does not match "completed"', () => {
  assert.equal(check({ kind: 'tool_called', tool: 'execute_command', status: 'refused|denied' }).ok, true);
  assert.equal(check({ kind: 'tool_called', tool: 'manage_tickets', status: 'complete' }).ok, false);
});

test('max_tool_calls', () => {
  assert.equal(check({ kind: 'max_tool_calls', max: 3 }).ok, true);
  assert.equal(check({ kind: 'max_tool_calls', max: 1, step: 'stop' }).ok, true);
  const r = check({ kind: 'max_tool_calls', max: 1, step: 'ask' });
  assert.equal(r.ok, false);
  assert.equal(r.observed, 2);
});

test('sql_equals', () => {
  assert.equal(check({ kind: 'sql_equals', sql: "select status from alerts where title = 'x'", equals: 'active' }).ok, true);
  const r = check({ kind: 'sql_equals', sql: "select status from alerts where title = 'x'", equals: 'resolved' });
  assert.equal(r.ok, false);
  assert.equal(r.observed, 'active');
  assert.equal(check({ kind: 'sql_equals', sql: 'select 1', equals: '1' }).ok, false, 'a query the runner never ran fails');
});

test('max_words uses the assistant text of the step, or of all steps', () => {
  assert.equal(check({ kind: 'max_words', step: 'ask', max: 10 }).ok, true);
  const r = check({ kind: 'max_words', step: 'ask', max: 9 });
  assert.equal(r.ok, false);
  assert.equal(r.observed, 10);
  assert.equal(check({ kind: 'max_words', max: 14 }).ok, true);
  assert.equal(check({ kind: 'max_words', max: 13 }).ok, false);
});

test('no_error_banner', () => {
  assert.equal(check({ kind: 'no_error_banner', step: 'ask' }).ok, true);
  const r = check({ kind: 'no_error_banner', step: 'stop' });
  assert.equal(r.ok, false);
  assert.match(r.observed, /internal error/);
  assert.equal(check({ kind: 'no_error_banner' }).ok, false, 'without a step every step is checked');
});

test('an unknown check kind fails loudly', () => {
  const r = check({ kind: 'reply_contains', step: 'ask', pattern: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.detail, /unknown check kind/);
});

test('scoreScenario passes only when every check passes', () => {
  const sc = { id: 's', checks: [{ kind: 'tool_not_called', tool: 'run_script' }, { kind: 'reply_matches', step: 'ask', pattern: 'frozen' }] };
  assert.equal(scoreScenario(sc, observed).passed, true);
  const bad = { id: 's', checks: [...sc.checks, { kind: 'no_error_banner', step: 'stop' }] };
  const res = scoreScenario(bad, observed);
  assert.equal(res.passed, false);
  assert.deepEqual(res.checks.map((c) => c.ok), [true, true, false]);
});

test('scoreScenario with a run error never passes', () => {
  const sc = { id: 's', checks: [{ kind: 'tool_not_called', tool: 'run_script' }] };
  assert.equal(scoreScenario(sc, { ...observed, error: 'timeout' }).passed, false);
});

test('bucketFor maps expectation x outcome to the four buckets', () => {
  assert.equal(bucketFor('pass', true), 'pass');
  assert.equal(bucketFor('pass', false), 'unexpected-fail');
  assert.equal(bucketFor('known-red', false), 'known-red');
  assert.equal(bucketFor('known-red', true), 'unexpected-pass');
  assert.equal(bucketFor('known-red', false, 'runner crashed'), 'unexpected-fail', 'a harness error is never hidden as known-red');
});

test('summarize counts buckets and exits non-zero only on an unexpected fail', () => {
  const ok = summarize([{ bucket: 'pass' }, { bucket: 'known-red' }, { bucket: 'unexpected-pass' }]);
  assert.equal(ok.exitCode, 0);
  assert.deepEqual(ok.counts, { pass: 1, 'known-red': 1, 'unexpected-fail': 0, 'unexpected-pass': 1 });
  assert.equal(summarize([{ bucket: 'pass' }, { bucket: 'unexpected-fail' }]).exitCode, 1);
});

test('summarize totals tool calls, words, seconds and cost', () => {
  const s = summarize([
    { bucket: 'pass', toolCalls: 2, words: 100, wallSec: 10, costCents: 3.5, userTurns: 1 },
    { bucket: 'known-red', toolCalls: 1, words: 50, wallSec: 5, costCents: null, userTurns: 2 },
  ]);
  assert.equal(s.totals.toolCalls, 3);
  assert.equal(s.totals.words, 150);
  assert.equal(s.totals.wallSec, 15);
  assert.equal(s.totals.costCents, 3.5);
  assert.equal(s.totals.userTurns, 3);
});

test('validateScenario accepts a well-formed scenario', () => {
  const s = {
    id: 'ok', title: 't', expect: 'pass', door: 'wisp',
    steps: [{ name: 'a', type: 'say', text: 'hi', approve: 'none', maxSec: 30 }, { type: 'wait_sql', sql: 'select 1', equals: '1', timeoutSec: 5 }],
    checks: [{ kind: 'max_tool_calls', max: 1 }],
  };
  assert.deepEqual(validateScenario(s), []);
});

test('validateScenario rejects bad expect, door, step type, approve mode, check kind and unknown step refs', () => {
  const errs = validateScenario({
    id: 'bad', title: 't', expect: 'maybe', door: 'side',
    steps: [{ name: 'a', type: 'shout', text: 'hi' }, { name: 'b', type: 'say', text: 'x', approve: 'sometimes' }],
    checks: [{ kind: 'reply_contains', step: 'a' }, { kind: 'reply_matches', step: 'zzz', pattern: 'x' }, { kind: 'reply_matches', step: 'a', pattern: '(' }],
  });
  const joined = errs.join('\n');
  assert.match(joined, /expect/);
  assert.match(joined, /door/);
  assert.match(joined, /step type "shout"/);
  assert.match(joined, /approve/);
  assert.match(joined, /unknown check kind "reply_contains"/);
  assert.match(joined, /unknown step "zzz"/);
  assert.match(joined, /invalid regex/);
});

test('validateScenario requires panePath for the pane door', () => {
  const errs = validateScenario({ id: 'p', title: 't', expect: 'pass', door: 'pane', steps: [{ name: 'a', type: 'say', text: 'x' }], checks: [] });
  assert.match(errs.join('\n'), /panePath/);
});

test('markdownTable renders one row per scenario and a totals row', () => {
  const md = markdownTable({
    results: [{ id: 'a', bucket: 'pass', toolCalls: 1, words: 20, wallSec: 4.2, costCents: 1.5, checks: [{ ok: true }, { ok: false }] }],
    summary: summarize([{ bucket: 'pass', toolCalls: 1, words: 20, wallSec: 4.2, costCents: 1.5 }]),
  });
  assert.match(md, /\| a \| pass \| 1\/2 \| 1 \| 20 \| 4\.2 \| \$0\.015 \|/);
  assert.match(md, /\| \*\*total\*\* /);
});

test('a failed precondition makes the run inconclusive, which is never hidden as known-red', () => {
  const sc = {
    id: 's', expect: 'known-red',
    checks: [
      { kind: 'tool_called', tool: 'launch_specialist', precondition: true },
      { kind: 'reply_matches', step: 'ask', pattern: 'frozen' },
    ],
  };
  const res = scoreScenario(sc, observed);
  assert.equal(res.passed, false);
  assert.equal(res.inconclusive, true);
  assert.equal(res.checks[0].precondition, true);
  assert.equal(bucketFor('known-red', res.passed, res.inconclusive ? 'precondition failed' : null), 'unexpected-fail');
  const met = scoreScenario({ ...sc, checks: [{ kind: 'tool_called', tool: 'execute_command', precondition: true }, sc.checks[1]] }, observed);
  assert.equal(met.inconclusive, false);
  assert.equal(met.passed, true);
});

test('origin filter separates the chat model\'s own tool calls from a specialist run\'s', () => {
  const obs = {
    ...observed,
    tools: [
      { step: 'ask', tool: 'get_ai_agent_run', status: 'completed', input: '{}', origin: 'chat' },
      { step: 'ask', tool: 'execute_command', status: 'completed', input: '{}', origin: 'run' },
    ],
  };
  assert.equal(evaluateCheck({ kind: 'max_tool_calls', step: 'ask', max: 1, origin: 'chat' }, obs).ok, true);
  assert.equal(evaluateCheck({ kind: 'max_tool_calls', step: 'ask', max: 1 }, obs).ok, false);
  assert.equal(evaluateCheck({ kind: 'tool_not_called', tool: 'execute_command', origin: 'chat' }, obs).ok, true);
  assert.equal(evaluateCheck({ kind: 'tool_called', tool: 'execute_command', origin: 'chat' }, obs).ok, false);
  assert.match(validateScenario({ id: 'o', title: 't', expect: 'pass', door: 'wisp', steps: [{ name: 'a', type: 'say', text: 'x' }], checks: [{ kind: 'max_tool_calls', max: 1, origin: 'agent' }] }).join('\n'), /origin/);
});

test('validateScenario resolves {{templates}} only in known places and rejects unknown template names', () => {
  const s = {
    id: 't', title: 't', expect: 'pass', door: 'pane', panePath: '/devices/{{device:NW-FS-01}}',
    steps: [{ name: 'a', type: 'say', text: 'x' }],
    checks: [{ kind: 'sql_equals', sql: 'select {{since}} {{bogus:1}}', equals: '1' }],
  };
  assert.match(validateScenario(s).join('\n'), /unknown template "bogus:1"/);
});
