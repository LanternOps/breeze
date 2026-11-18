import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOSING_KEYWORD, actionId, latestMarker, parseMarkers, renderComment, renderMarker } from './markers.mjs';

// Decision markers and action ids (W06b B1, #10750).

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const marker = (over = {}) => ({
  v: 1,
  action: actionId({ pr: 11312, headSha: HEAD, runId: 42453222760, runAttempt: 1 }),
  pr: 11312,
  head: HEAD,
  run: 42453222760,
  attempt: 1,
  removal: 'RFMQE_1',
  class: 'infra',
  decision: 'record',
  status: 'intent',
  removals: 2,
  limit: 3,
  at: '2026-11-08T07:08:00Z',
  ...over,
});
const comment = (body, author = 'operator', id = 1) => ({ id, author, body });

test('actionId: run-keyed, else removal-keyed', () => {
  assert.equal(actionId({ pr: 7, headSha: HEAD, runId: 99, runAttempt: 2, removalId: 'X' }), `7:${HEAD.slice(0, 12)}:99:2`);
  assert.equal(actionId({ pr: 7, headSha: HEAD, runId: null, removalId: 'RFMQE_9' }), `7:${HEAD.slice(0, 12)}:r:RFMQE_9`);
  assert.throws(() => actionId({ pr: 7, headSha: HEAD, runId: null }), /removalId/);
});

test('render → parse round-trips', () => {
  const m = marker({ hold_reason: 'retry_exhausted', decision: 'hold' });
  const parsed = parseMarkers([comment(`Some text.\n\n${renderMarker(m)}`)], { viewer: 'operator' });
  assert.equal(parsed.length, 1);
  const { commentId, ...rest } = parsed[0];
  assert.equal(commentId, 1);
  assert.deepEqual(rest, m);
});

test('keys are sorted, and the JSON cannot close the HTML comment early', () => {
  const text = renderMarker(marker({ class: 'x-->y' }));
  assert.match(text, /^<!-- ci-shepherd:v1 \{.*\} -->$/);
  const json = text.slice('<!-- ci-shepherd:v1 '.length, -' -->'.length);
  const keys = Object.keys(JSON.parse(json));
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(text.indexOf('-->'), text.length - 3, 'only the final --> closes the comment');
  assert.equal(parseMarkers([comment(text)], { viewer: 'operator' })[0].class, 'x-->y');
});

test('a marker from another author is ignored', () => {
  assert.deepEqual(parseMarkers([comment(renderMarker(marker()), 'someone-else')], { viewer: 'operator' }), []);
  assert.deepEqual(parseMarkers([comment(renderMarker(marker()), 'operator')], { viewer: null }), [], 'no viewer → trust nothing');
});

test('a truncated or malformed marker is ignored', () => {
  const good = renderMarker(marker());
  const bodies = [
    good.slice(0, -10),
    '<!-- ci-shepherd:v1 {not json} -->',
    '<!-- ci-shepherd:v1 [] -->',
    renderMarker(marker({ v: 2 })),
    renderMarker(marker({ status: 'maybe' })),
    renderMarker(marker({ pr: 'x' })),
    renderMarker(marker({ action: '' })),
  ];
  assert.deepEqual(parseMarkers(bodies.map((b, i) => comment(b, 'operator', i)), { viewer: 'operator' }), []);
});

test('two markers with one action id: the later status wins', () => {
  const comments = [comment(renderMarker(marker({ status: 'intent' })), 'operator', 1), comment(renderMarker(marker({ status: 'done' })), 'operator', 2)];
  const parsed = parseMarkers(comments, { viewer: 'operator' });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].status, 'done');
  assert.equal(parsed[0].commentId, 2);
  // A later decision for the same action (a record re-decided as requeue) supersedes too.
  const later = [...comments, comment(renderMarker(marker({ decision: 'requeue', status: 'intent' })), 'operator', 3)];
  assert.equal(latestMarker(parseMarkers(later, { viewer: 'operator' }), marker().action).decision, 'requeue');
});

test('comments are neutral: no mention, no closing keyword, no issue reference', () => {
  for (const kind of ['record', 'requeue', 'hold', 'backoff', 'wait_main', 'restore', 'resume', 'resume_new_head']) {
    const text = renderComment(
      { kind, holdReason: kind === 'hold' ? 'real' : undefined, reasons: ['fixes #12 @someone closes #9'], signature: 'download_5xx' },
      marker({ decision: kind }),
    );
    assert.doesNotMatch(text, /@\w/, kind);
    assert.doesNotMatch(text, CLOSING_KEYWORD, kind);
    assert.doesNotMatch(text.replace(/<!-- ci-shepherd:v1 .* -->/s, ''), /#\d/, kind);
  }
});
