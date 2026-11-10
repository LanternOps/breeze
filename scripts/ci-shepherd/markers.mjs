// Decision markers and action ids (W06b B1, #10750).
//
// Every decision the shepherd applies in act mode leaves one comment on the
// PR: a short neutral explanation followed by a hidden marker
//   <!-- ci-shepherd:v1 {"action":…,"status":"intent"} -->
// posted (status `intent`) before any mutation and edited to `done` after the
// last one. The marker is the idempotency record: a tick that finds a marker
// for its action does not post another, and a marker left at `intent` is
// finished by the next tick. Only markers the operator login wrote are
// trusted; anyone can paste the same text into a comment.
//
// The marker prefix, `decision` and `hold_reason` values are an interface:
// the orchestrator's queue watcher reads them.

export const MARKER_PREFIX = '<!-- ci-shepherd:v1 ';
const MARKER_RE = /<!-- ci-shepherd:v1 (.*?) -->/gs;
export const STATUSES = new Set(['intent', 'done', 'skipped']);
// GitHub closes an issue on these whatever surrounds them, negation included.
export const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*(?:[\w.-]+\/[\w.-]+)?#\d+/i;

// `<pr>:<head12>:<run>:<attempt>`, or `<pr>:<head12>:r:<removal>` when no
// group run was found. One action per (PR head, queue run).
export function actionId({ pr, headSha, runId, runAttempt, removalId }) {
  const head = String(headSha ?? '').slice(0, 12);
  if (!Number.isInteger(pr) || head.length !== 12) throw new Error(`actionId: bad pr/head ${pr}/${headSha}`);
  if (runId !== null && runId !== undefined) return `${pr}:${head}:${runId}:${runAttempt ?? 1}`;
  if (!removalId) throw new Error('actionId: a removalId is required when there is no run');
  return `${pr}:${head}:r:${removalId}`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => [k, sortKeys(value[k])]),
    );
  }
  return value;
}

// `<` and `>` only ever occur inside JSON strings, where \u escapes are
// equivalent, so no value can end the HTML comment early.
export function renderMarker(m) {
  const json = JSON.stringify(sortKeys(m)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `${MARKER_PREFIX}${json} -->`;
}

function validMarker(m) {
  return (
    m &&
    typeof m === 'object' &&
    !Array.isArray(m) &&
    m.v === 1 &&
    typeof m.action === 'string' &&
    m.action.length > 0 &&
    Number.isInteger(m.pr) &&
    m.pr > 0 &&
    typeof m.decision === 'string' &&
    m.decision.length > 0 &&
    STATUSES.has(m.status)
  );
}

// comments: [{ id, author, body }] oldest first. Returns one marker per action
// (the latest one wins), each with the `commentId` it came from.
export function parseMarkers(comments, { viewer }) {
  if (!viewer) return [];
  const byAction = new Map();
  for (const c of comments) {
    if (c.author !== viewer || typeof c.body !== 'string') continue;
    for (const match of c.body.matchAll(MARKER_RE)) {
      let m;
      try {
        m = JSON.parse(match[1]);
      } catch {
        continue;
      }
      if (!validMarker(m)) continue;
      byAction.delete(m.action);
      byAction.set(m.action, { ...m, commentId: c.id ?? null });
    }
  }
  return [...byAction.values()];
}

export const latestMarker = (markers, action) => markers.find((m) => m.action === action) ?? null;

// Free text from verdicts can quote test names or log lines: drop anything
// that would mention a user or reference (and so maybe close) an issue.
const neutral = (s) => String(s).replace(/@/g, '').replace(/#(?=\d)/g, 'no. ').slice(0, 300);

const LINES = {
  record: (d) => `The merge queue removed this PR after a ${d.className} failure${d.sig}. GitHub is re-adding it through auto-merge; this removal counts ${d.count} against this head's retry budget.`,
  requeue: (d) => `The merge queue removed this PR after a ${d.className} failure${d.sig}. Re-queued (${d.count} of this head's retry budget).`,
  hold: (d) =>
    `The merge queue removed this PR and the shepherd is holding it (${d.holdReason}): ${d.className} failure${d.sig}, ${d.count}. Auto-merge is off. Push a fix, or add the label \`ci-shepherd:resume\` to re-queue as is.`,
  backoff: (d) => `The merge queue removed this PR during a CI infrastructure outage${d.sig}. Parked until it clears; auto-merge comes back on its own.`,
  wait_main: () => 'The merge queue removed this PR on a test that is failing for several PRs at once, so main itself may be broken. Parked until main is checked; auto-merge comes back on its own.',
  restore: () => 'The outage or broken-main condition that parked this PR has cleared. Auto-merge is back on.',
  resume: () => 'Released by the `ci-shepherd:resume` label. Auto-merge is back on; the retry budget for this head is unchanged.',
  resume_new_head: () => 'The head changed since the hold, so the shepherd labels are removed. A new head starts a new retry budget.',
  requeue_stuck: () => 'This queue entry finished its CI run without a `CI Success` result, so it would wait for the queue timeout. Re-queued.',
  probe: () => 'Probe of the shepherd write path (hold, then resume). No action needed.',
};

// The comment the shepherd posts for a decision: one or two neutral lines and
// the marker. Never an @mention, never an issue reference.
export function renderComment(decision, m) {
  const d = {
    className: neutral(m.class ?? 'unclassified').replace(/_/g, ' '),
    sig: decision.signature ? ` (\`${neutral(decision.signature)}\`)` : '',
    holdReason: neutral(decision.holdReason ?? m.hold_reason ?? 'held').replace(/_/g, ' '),
    count: m.limit !== undefined && m.removals !== undefined ? `removal ${m.removals} of ${m.limit} allowed` : 'budget not counted',
  };
  const line = (LINES[decision.kind] ?? (() => `CI shepherd decision: ${neutral(decision.kind)}.`))(d);
  const text = `**CI shepherd:** ${line}`.replace(/@/g, '').replace(/#(?=\d)/g, 'no. ');
  if (CLOSING_KEYWORD.test(text)) throw new Error('renderComment: refusing a closing keyword');
  return `${text}\n\n${renderMarker(m)}`;
}
