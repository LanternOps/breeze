// One `flaky-test` issue per flaky test, carrying its evidence (W06c C1, #10750).
//
// The issue is the durable evidence store: a human summary, then a hidden
// marker `<!-- ci-shepherd:flake v1 <json> -->` holding the FlakeRecord
//   { runner, id, file, total: { fail_pass, fail_fail, fail_other },
//     quarantine_days, quarantine_through, sightings: Sighting[] }
// with the newest 50 sightings (fewer when the body would pass 60,000 chars;
// `total` always counts every sighting ever merged). `quarantine_days` counts
// the ledger days the test has been quarantined in total (each entry's days
// after its `added`, through `quarantine_through`, the last day counted); the
// ledger proposals cap it at 60.
//
// An issue is opened only once a test has sightings from 2 distinct CI runs
// within 14 days. Issues are trusted only when the operator login wrote them
// (anyone can paste a marker). A closed issue is a human's call and is left
// alone; evidence that arrives after the close opens a successor under the
// same rule, carrying the quarantine days (the 60-day cap is per test, not
// per issue). Writes go through the writer (act mode only); without one, the
// caller learns what would have been created.
import { renameSync, readFileSync, writeFileSync } from 'node:fs';
import { RUNNERS } from '../../.github/scripts/flaky-ledger.mjs';

export const FLAKE_LABEL = 'flaky-test';
export const FIX_REQUIRED_LABEL = 'flaky-fix-required';
export const MAX_SIGHTINGS = 50;
export const MAX_BODY = 60_000;
export const MAX_TITLE = 120;
export const CREATE_RUNS = 2;
export const CREATE_WINDOW_DAYS = 14;
export const QUARANTINE_CAP_DAYS = 60;
// Issue creates + edits per upsert call; the rest wait for the next tick.
export const MAX_ISSUE_WRITES = 10;
const ISSUE_PAGES = 10;
const MARKER_PREFIX = '<!-- ci-shepherd:flake v1 ';
const MARKER_RE = /<!-- ci-shepherd:flake v1 (.*?) -->/gs;
const KINDS = ['fail_pass', 'fail_fail', 'fail_other'];
const DAY = 86_400_000;

const ms = (s) => Date.parse(s);
const dayNumber = (d) => Date.parse(`${d}T00:00:00Z`) / DAY;
const dayOf = (n) => new Date(n * DAY).toISOString().slice(0, 10);

export const flakeKey = (runner, id) => `${runner}|${id}`;
const sightingKey = (s) => `${s.run}\0${s.attempt}\0${s.job}\0${s.runner}\0${s.id}`;

// Test ids and job names are free text: nothing posted may mention a user or
// reference (and so maybe close) an issue.
// Nor open or close an HTML comment: the record is the body's last comment.
export const neutralText = (s) =>
  String(s)
    .replace(/@/g, '')
    .replace(/#(?=\d)/g, 'no. ')
    .replace(/\bGH-(?=\d)/gi, 'GH ')
    .replace(/\/(issues|pull)\/(?=\d)/gi, '/$1 /')
    .replace(/`/g, "'")
    .replace(/[\r\n|]+/g, ' ')
    .replace(/<!--/g, '<! --')
    .replace(/--!?>/g, '-- >');

// The last segment of a test id: the vitest test name, or the Go test name.
function lastSegment(runner, id) {
  if (runner === 'go') {
    const m = /\.((?:Test|Fuzz|Example)[^.]*)$/.exec(id);
    return m ? m[1] : id;
  }
  return id.split(' > ').at(-1);
}

const basename = (p) => String(p ?? '').split('/').filter(Boolean).at(-1) ?? '';

function title(record) {
  const t = neutralText(`Flaky test: ${record.runner} ${basename(record.file) || '?'} > ${lastSegment(record.runner, record.id)}`);
  return t.length <= MAX_TITLE ? t : `${t.slice(0, MAX_TITLE - 1)}…`;
}

// `<` and `>` only occur inside JSON strings, where \u escapes are
// equivalent, so no value can end the HTML comment early.
const markerJson = (record) => JSON.stringify(record).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

const RULES =
  'A flaky test is quarantined only through `.github/flaky-tests.json`, by a ledger PR, for at most 14 days at a time and 60 days in total; a quarantine never excuses a failure in a PR that touches the test or its sibling source.';

function renderBody(record) {
  const t = record.total;
  const code = (s) => `\`${neutralText(s)}\``;
  const lines = [
    'The CI shepherd saw this test fail in CI runs whose failures it could not tie to the change under test.',
    '',
    '| | |',
    '|---|---|',
    `| Runner | ${code(record.runner)} |`,
    `| Test | ${code(record.id)} |`,
    `| File | ${record.file ? code(record.file) : 'unknown'} |`,
    `| Failed, then passed on the retry | ${t.fail_pass} |`,
    `| Failed both attempts | ${t.fail_fail} |`,
    `| Failed once while the retry failed on others | ${t.fail_other} |`,
    `| Days quarantined so far | ${record.quarantine_days} of ${QUARANTINE_CAP_DAYS} |`,
    '',
  ];
  const newest = record.sightings.slice(-10).reverse();
  if (newest.length) {
    lines.push('Newest sightings:', '', '| When (UTC) | Kind | Event | PR | Job | Run |', '|---|---|---|---|---|---|');
    for (const s of newest) {
      const when = String(s.at).replace('T', ' ').replace(/:\d\dZ$/, '');
      const run = Number.isInteger(s.run) ? `[${s.run}](https://github.com/LanternOps/breeze/actions/runs/${s.run})` : '-';
      lines.push(`| ${neutralText(when)} | ${neutralText(s.kind)} | ${neutralText(s.event ?? '-')} | ${Number.isInteger(s.pr) ? s.pr : '-'} | ${neutralText(s.job ?? '-')} | ${run} |`);
    }
    lines.push('');
  }
  lines.push(RULES, '', 'This issue is kept up to date by the shepherd; the block below is its record.', '');
  return `${lines.join('\n')}\n${MARKER_PREFIX}${markerJson(record)} -->\n`;
}

// { title, body }. Past MAX_BODY the oldest sightings go first; `total` stays.
export function renderFlakeIssue(record) {
  let rec = record;
  let body = renderBody(rec);
  while (body.length > MAX_BODY && rec.sightings.length > 0) {
    const drop = Math.max(1, Math.ceil(((body.length - MAX_BODY) / body.length) * rec.sightings.length));
    rec = { ...rec, sightings: rec.sightings.slice(drop) };
    body = renderBody(rec);
  }
  return { title: title(rec), body, record: rec };
}

const isCount = (n) => Number.isInteger(n) && n >= 0;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validRecord(r) {
  return (
    r &&
    typeof r === 'object' &&
    !Array.isArray(r) &&
    RUNNERS.includes(r.runner) &&
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    (r.file === null || typeof r.file === 'string') &&
    r.total &&
    KINDS.every((k) => isCount(r.total[k])) &&
    isCount(r.quarantine_days) &&
    (r.quarantine_through === null || (typeof r.quarantine_through === 'string' && DATE.test(r.quarantine_through))) &&
    Array.isArray(r.sightings) &&
    r.sightings.every((s) => s && typeof s === 'object' && KINDS.includes(s.kind) && typeof s.at === 'string' && !Number.isNaN(ms(s.at)))
  );
}

export function parseFlakeIssue(body) {
  if (typeof body !== 'string') return null;
  // The shepherd's record is the last marker in the body.
  const m = [...body.matchAll(MARKER_RE)].at(-1);
  if (!m) return null;
  try {
    const r = JSON.parse(m[1]);
    return validRecord(r) ? r : null;
  } catch {
    return null;
  }
}

const emptyRecord = ({ runner, id, file }) => ({ runner, id, file: file ?? null, total: { fail_pass: 0, fail_fail: 0, fail_other: 0 }, quarantine_days: 0, quarantine_through: null, sightings: [] });

// Merge sightings of one test into its record: { record, added }. Each
// sighting counts once. Once any sighting has fallen off the kept list, a
// sighting no newer than the oldest kept one is ignored: it may be one that
// fell off, and counting it again would inflate `total`.
export function mergeSightings(prev, sightings, base) {
  const rec = prev ? structuredClone(prev) : emptyRecord(base);
  if (!rec.file && base.file) rec.file = base.file;
  const kept = new Set(rec.sightings.map(sightingKey));
  const counted = KINDS.reduce((s, k) => s + rec.total[k], 0);
  const floor = counted > rec.sightings.length && rec.sightings.length ? Math.min(...rec.sightings.map((s) => ms(s.at))) : -Infinity;
  let added = 0;
  for (const s of [...sightings].sort((a, b) => ms(a.at) - ms(b.at))) {
    if (s.runner !== rec.runner || s.id !== rec.id || !KINDS.includes(s.kind)) continue;
    const k = sightingKey(s);
    if (kept.has(k) || !(ms(s.at) > floor)) continue;
    kept.add(k);
    rec.sightings.push(s);
    rec.total[s.kind]++;
    added++;
  }
  rec.sightings.sort((a, b) => ms(a.at) - ms(b.at));
  if (rec.sightings.length > MAX_SIGHTINGS) rec.sightings = rec.sightings.slice(-MAX_SIGHTINGS);
  return { record: rec, added };
}

// Count the days a ledger entry has quarantined this test, through `today`.
// An entry contributes the days after its `added` (so a renewal on the day
// the old entry is still active does not count that day twice); days already
// counted (through `quarantine_through`) are not counted again.
export function accrueQuarantine(record, entry, today) {
  if (!entry) return { record, changed: false };
  const from = Math.max(dayNumber(entry.added), record.quarantine_through ? dayNumber(record.quarantine_through) : -Infinity);
  const to = Math.min(dayNumber(today), dayNumber(entry.expires));
  if (!(to > from)) return { record, changed: false };
  return { record: { ...record, quarantine_days: record.quarantine_days + (to - from), quarantine_through: dayOf(to) }, changed: true };
}

// { index, records } from every `flaky-test` issue the operator wrote. Index
// entries: { issue, open, closedAt, labels, since }. Per test: its open issue,
// or else its most recently closed one. `since` (open issues): the latest
// close among the test's earlier issues; evidence from before it was a human's
// "fixed" and does not count again.
// Also `unparsable` (operator-written flaky-test issues whose record does not
// parse: a human edited it, or a newer schema) and `truncated` (more issues
// than the pages read). Either means some test's issue may be missing from
// the index, so the caller must not open new issues: one could duplicate it
// and restart its quarantine days.
export async function refreshIndex(gh, { repo, viewer }) {
  if (!viewer) throw new Error('refreshIndex: the operator login is required');
  const index = {};
  const records = {};
  const unparsable = [];
  let truncated = false;
  // Per test, the latest close among its issues: a successor's evidence starts after it.
  const lastClose = {};
  for (let page = 1; page <= ISSUE_PAGES; page++) {
    const res = await gh.rest('GET', `repos/${repo}/issues?labels=${encodeURIComponent(FLAKE_LABEL)}&state=all&per_page=100&page=${page}`);
    if (res.status !== 200) throw new Error(`flaky-test issue listing: ${res.status}`);
    for (const issue of res.body) {
      if (issue.pull_request || issue.user?.login !== viewer) continue;
      const rec = parseFlakeIssue(issue.body);
      if (!rec) {
        unparsable.push(issue.number);
        continue;
      }
      const key = flakeKey(rec.runner, rec.id);
      const entry = { issue: issue.number, open: issue.state === 'open', closedAt: issue.closed_at ?? null, labels: (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)) };
      if (entry.closedAt && !(ms(lastClose[key] ?? 0) >= ms(entry.closedAt))) lastClose[key] = entry.closedAt;
      const prev = index[key];
      const better = !prev || (entry.open && !prev.open) || (entry.open === prev.open && (entry.open ? entry.issue > prev.issue : ms(entry.closedAt ?? 0) > ms(prev.closedAt ?? 0)));
      if (better) {
        index[key] = entry;
        records[key] = rec;
      }
    }
    if (res.body.length < 100) break;
    if (page === ISSUE_PAGES) truncated = true;
  }
  for (const [key, entry] of Object.entries(index)) entry.since = entry.open ? (lastClose[key] ?? null) : null;
  return { index, records, unparsable, truncated };
}

// sightings: every local sighting (any age; the create rule looks at 14 days).
// index/records: from the last refresh and earlier calls. Returns the new
// index and records plus what was created, updated, would be created (no
// writer) and deferred (over `maxWrites`). `onIntent(key)` runs before each
// create, so the caller can save that it may have happened: after a crash, a
// refresh finds the issue instead of opening a second one. One test's write
// failing is collected in `failed` ({ key, op, error }) and the rest go on;
// only the API budget stops the loop. `allowCreate: false` (the index may be
// incomplete) skips creates and lists them in `blocked`.
export async function upsertFlakeIssues(gh, { repo, sightings, index, records, writer = null, viewer, now, ledger = [], today = new Date(now).toISOString().slice(0, 10), maxWrites = MAX_ISSUE_WRITES, allowCreate = true, onIntent = () => {} }) {
  const nextIndex = { ...index };
  const nextRecords = { ...records };
  const out = { index: nextIndex, records: nextRecords, created: [], updated: [], wouldCreate: [], wouldUpdate: [], blocked: [], failed: [], deferred: 0 };
  const byKey = new Map();
  for (const s of sightings) {
    const k = flakeKey(s.runner, s.id);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(s);
  }
  const ledgerByKey = new Map(ledger.map((e) => [flakeKey(e.runner, e.id), e]));
  const keys = [...new Set([...byKey.keys(), ...[...ledgerByKey.keys()].filter((k) => nextIndex[k]?.open)])].sort();
  let writes = 0;
  let labelReady = false;
  for (const key of keys) {
    const list = byKey.get(key) ?? [];
    const entry = nextIndex[key];
    const [runner, ...rest] = key.split('|');
    const base = { runner, id: rest.join('|'), file: list.find((s) => s.file)?.file ?? null };
    if (entry?.open) {
      // An open issue with no record would be re-rendered from zero and lose
      // its totals and quarantine days: leave it for the next refresh.
      if (!nextRecords[key]) {
        out.failed.push({ key, op: 'issue_edit', error: 'no local record for an open issue; waiting for the refresh' });
        continue;
      }
      const since = entry.since ? ms(entry.since) : -Infinity;
      const merged = mergeSightings(nextRecords[key] ?? null, list.filter((s) => ms(s.at) > since), base);
      const accrued = accrueQuarantine(merged.record, ledgerByKey.get(key), today);
      if (!merged.added && !accrued.changed) continue;
      if (!writer) {
        out.wouldUpdate.push(key);
        continue;
      }
      if (writes >= maxWrites) {
        out.deferred++;
        continue;
      }
      const rendered = renderFlakeIssue(accrued.record);
      writes++;
      try {
        await writer.editIssue(entry.issue, { body: rendered.body });
      } catch (e) {
        if (e.name === 'BudgetExceeded') throw e;
        out.failed.push({ key, op: 'issue_edit', error: e.message, status: e.status ?? null });
        continue;
      }
      nextRecords[key] = rendered.record;
      out.updated.push(key);
      continue;
    }
    // No open issue: a new one needs 2 distinct runs within 14 days (and,
    // after a closed one, after its close).
    const after = Math.max(now - CREATE_WINDOW_DAYS * DAY, entry?.closedAt ? ms(entry.closedAt) : -Infinity);
    const fresh = list.filter((s) => ms(s.at) > after && ms(s.at) <= now);
    if (new Set(fresh.map((s) => s.run)).size < CREATE_RUNS) continue;
    if (!writer) {
      out.wouldCreate.push(key);
      continue;
    }
    if (!allowCreate) {
      out.blocked.push(key);
      continue;
    }
    if (writes >= maxWrites) {
      out.deferred++;
      continue;
    }
    const prior = entry ? nextRecords[key] : null;
    const seed = prior ? { ...emptyRecord(base), quarantine_days: prior.quarantine_days, quarantine_through: prior.quarantine_through } : null;
    const merged = mergeSightings(seed, fresh, base);
    const rendered = renderFlakeIssue(merged.record);
    let number;
    try {
      if (!labelReady) {
        await writer.ensureLabel(FLAKE_LABEL, { color: 'fbca04', description: 'A test the CI shepherd saw fail intermittently' });
        labelReady = true;
      }
      onIntent(key);
      writes++;
      number = await writer.createIssue({ title: rendered.title, body: rendered.body, labels: [FLAKE_LABEL] });
    } catch (e) {
      if (e.name === 'BudgetExceeded') throw e;
      out.failed.push({ key, op: 'issue_create', error: e.message, status: e.status ?? null });
      continue;
    }
    nextIndex[key] = { issue: number, open: true, closedAt: null, labels: [FLAKE_LABEL], since: entry?.closedAt ?? null };
    nextRecords[key] = rendered.record;
    out.created.push(key);
  }
  return out;
}

// flake-records.json: the parsed issue records, beside state.json.
// An entry that is not a valid record is dropped, so the caller's
// missing-record rule refreshes it from its issue.
export function loadRecords(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    // Unreadable or torn: rebuilt from the issues by the next refresh.
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter(([, r]) => validRecord(r)));
}

export function saveRecords(path, records) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(records)}\n`);
  renameSync(tmp, path);
}
