// Flaky-test upkeep, once per tick after sightings ingest (W06c, #10750):
//   1. flaky-test issues from the local sightings (flake-issues.mjs);
//   2. ledger proposals from those records and main's ledger
//      (ledger-proposals.mjs), plus the `flaky-fix-required` label;
//   3. the rolling ledger PR (ledger-pr.mjs), checked at most hourly.
// Writes only in act mode, through the tick's writer. In shadow every step
// still runs on reads and records what it would do in decisions.jsonl, once
// per test (issues) or proposal (ledger PR) per day.
//
// Local state: `state.flake` = { refreshedAt, index, pending, evidenceSince,
// ledgerCheckedAt, logged } in state.json; the parsed issue records in
// `flake-records.json` beside it.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LEDGER_PATH } from '../../.github/scripts/flaky-ledger.mjs';
import { FIX_REQUIRED_LABEL, accrueQuarantine, flakeKey, loadRecords, refreshIndex, saveRecords, upsertFlakeIssues } from './flake-issues.mjs';
import { ledgerPrTick, readMainLedger } from './ledger-pr.mjs';
import { isEmptyProposal, proposeLedger } from './ledger-proposals.mjs';
import { readJsonl } from './state.mjs';
import { gitCli } from './writer.mjs';

const DAY = 86_400_000;
export const REFRESH_MS = DAY;
export const LEDGER_CHECK_MS = 3600_000;
const ms = (s) => Date.parse(s);
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sightingKey = (s) => `${s.run}\0${s.attempt}\0${s.job}\0${s.runner}\0${s.id}`;

const emptyFlake = () => ({ refreshedAt: null, viewer: null, index: {}, pending: {}, incomplete: null, evidenceSince: null, ledgerCheckedAt: null, unenqueued: null, logged: {} });

// main's ledger and file checks: origin/main of the shepherd's clone when the
// tick has one (run.sh passes it), else the checkout the tick runs from.
function mainLedger(t, git) {
  if (t.checkoutDir) return readMainLedger(git, t.checkoutDir);
  const ledger = JSON.parse(readFileSync(join(t.repoRoot, LEDGER_PATH), 'utf8'));
  const fileExists = (p) => typeof p === 'string' && !!p && !p.startsWith('/') && !p.split('/').includes('..') && existsSync(join(t.repoRoot, p));
  return { ledger, fileExists };
}

// Records for the proposals: every test with an issue record, local
// sightings or a ledger entry. Sightings are the issue's and the local
// store's, deduped; for a successor issue, only those after the last close.
export function proposalRecords({ index, records, sightings, ledger, today }) {
  const local = new Map();
  for (const s of sightings) {
    const k = flakeKey(s.runner, s.id);
    if (!local.has(k)) local.set(k, []);
    local.get(k).push(s);
  }
  const ledgerOf = new Map(ledger.map((e) => [flakeKey(e.runner, e.id), e]));
  const keys = new Set([...Object.keys(index), ...local.keys(), ...ledgerOf.keys()]);
  const out = [];
  for (const key of [...keys].sort()) {
    const entry = index[key];
    const rec = records[key] ?? null;
    const [runner, ...rest] = key.split('|');
    const id = rest.join('|');
    const since = entry?.open && entry.since ? ms(entry.since) : entry && !entry.open && entry.closedAt ? ms(entry.closedAt) : -Infinity;
    const seen = new Set();
    const list = [];
    for (const s of [...(rec?.sightings ?? []), ...(local.get(key) ?? [])]) {
      const k = sightingKey(s);
      if (seen.has(k) || !(ms(s.at) > since)) continue;
      seen.add(k);
      list.push(s);
    }
    const quarantine = rec ? accrueQuarantine({ ...rec }, ledgerOf.get(key), today).record.quarantine_days : 0;
    out.push({ runner, id, file: rec?.file ?? list.find((s) => s.file)?.file ?? ledgerOf.get(key)?.file ?? null, issue: entry?.open ? entry.issue : null, quarantine_days: quarantine, sightings: list });
  }
  return out;
}

const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

// t: the tick context (tick.mjs), with `modeNow`, `writer`, `viewer`,
// `stateDir`, `checkoutDir`, `record` and `save`.
export async function flakeUpkeep(t, { git = gitCli } = {}) {
  const fl = (t.state.flake = { ...emptyFlake(), ...(t.state.flake ?? {}) });
  const now = t.now;
  const today = iso(now).slice(0, 10);
  fl.evidenceSince ??= iso(now);
  fl.logged = Object.fromEntries(Object.entries(fl.logged).filter(([, at]) => now - ms(at) < 2 * DAY));
  const out = { created: 0, updated: 0, ledger: null };
  const sightings = readJsonl(t.sightingsPath);
  const main = mainLedger(t, git);
  if (!sightings.length && !main.ledger.length && !Object.keys(fl.pending).length && !Object.keys(fl.index).length) return out;

  // Act only if act still holds now (mode is re-read before each write batch).
  const acting = t.mode === 'act' && (await t.modeNow()) === 'act';
  const writer = acting ? t.writer : null;
  const shadowLog = (kind, key, entry) => {
    const k = `${today}:${kind}:${key}`;
    if (fl.logged[k]) return;
    fl.logged[k] = iso(now);
    t.record({ actionId: `flake:${kind}:${key}`, kind, pr: null, mutations: [], reasons: [], mode: t.mode, status: 'shadow', source: 'flake', at: iso(now), ...entry });
  };

  const recordsPath = join(t.stateDir, 'flake-records.json');
  let records = loadRecords(recordsPath);
  // Shadow ticks have no viewer of their own; the login is read once a day.
  const viewer = t.viewer ?? (fl.refreshedAt && now - ms(fl.refreshedAt) < REFRESH_MS ? fl.viewer : null) ?? (await t.gh.rest('GET', 'user')).body?.login;
  if (!viewer) throw new Error('flake upkeep: cannot read the operator login');
  fl.viewer = viewer;
  // Refresh daily, after a create whose outcome is unknown, and whenever the
  // index names a test whose record is missing (a lost flake-records.json
  // must not reset its quarantine days to 0).
  const stale = !fl.refreshedAt || now - ms(fl.refreshedAt) >= REFRESH_MS;
  if (stale || Object.keys(fl.pending).length || Object.keys(fl.index).some((k) => !records[k])) {
    const r = await refreshIndex(t.gh, { repo: t.repo, viewer });
    fl.index = r.index;
    records = r.records;
    fl.refreshedAt = iso(now);
    fl.pending = {};
    // Until the next refresh says otherwise: an issue it could not read may
    // be some test's, so no new issue may be opened (it could duplicate one
    // and restart its quarantine days).
    fl.incomplete = r.unparsable.length || r.truncated ? { unparsable: r.unparsable, truncated: r.truncated } : null;
    saveRecords(recordsPath, records);
  }
  if (fl.incomplete) {
    t.error(`flaky tests: no new issues while the flaky-test listing is incomplete (${fl.incomplete.truncated ? 'over the page cap' : `unreadable record on issue(s) ${fl.incomplete.unparsable.join(', ')}`})`);
  }

  // 1. Issues.
  // A create's intent is saved first (`pending`): after a crash, the next
  // tick's refresh finds the issue instead of opening a second one.
  const up = await upsertFlakeIssues(t.gh, {
    repo: t.repo,
    sightings,
    index: fl.index,
    records,
    writer,
    viewer,
    now,
    today,
    ledger: main.ledger,
    allowCreate: !fl.incomplete,
    onIntent: (key) => {
      fl.pending[key] = iso(now);
      t.save();
    },
  });
  fl.index = up.index;
  records = up.records;
  if (up.created.length || up.updated.length) saveRecords(recordsPath, records);
  for (const key of up.created) delete fl.pending[key];
  for (const f of up.failed) {
    // A create GitHub definitely refused (4xx) did not happen: no refresh is
    // owed for it. A 5xx or network error might have landed; keep the intent.
    if (f.op === 'issue_create' && f.status >= 400 && f.status < 500) delete fl.pending[f.key];
    t.error(`flaky tests: ${f.op} for ${f.key.slice(0, 120)}: ${f.error}`);
  }
  out.created = up.created.length;
  out.updated = up.updated.length;
  for (const key of up.wouldCreate) shadowLog('flake_issue_create', key, { mutations: [{ op: 'issue_create', args: { key } }] });
  for (const key of up.created) t.record({ actionId: `flake:flake_issue_create:${key}`, kind: 'flake_issue_create', pr: null, mutations: [{ op: 'issue_create', args: { key } }], reasons: [], mode: t.mode, status: 'applied', source: 'flake', issue: fl.index[key]?.issue, at: iso(now) });

  // 2. Proposals.
  const propose = () =>
    proposeLedger({
      ledger: main.ledger,
      records: proposalRecords({ index: fl.index, records, sightings, ledger: main.ledger, today }),
      breakers: t.state.breakers?.breakers ?? [],
      today,
      fileExists: main.fileExists,
      evidenceSince: fl.evidenceSince,
    });
  let proposal = propose();
  // Shadow opens no issue, so its adds wait on one: say so, so a shadow review
  // sees what act would quarantine.
  if (!writer) for (const key of proposal.waitingIssue) shadowLog('ledger_add_waiting_issue', key, { mutations: [{ op: 'ledger_add', args: { key } }] });
  for (const key of proposal.fixRequired) {
    const entry = fl.index[key];
    if (!entry?.open || entry.labels?.includes(FIX_REQUIRED_LABEL)) continue;
    if (!writer) {
      shadowLog('flake_fix_required', key, { mutations: [{ op: 'label_add', args: { issue: entry.issue, name: FIX_REQUIRED_LABEL } }] });
      continue;
    }
    await writer.ensureLabel(FIX_REQUIRED_LABEL, { color: 'd93f0b', description: 'A flaky test that used its 60 quarantine days: fix it' });
    await writer.addLabel(entry.issue, FIX_REQUIRED_LABEL);
    entry.labels = [...(entry.labels ?? []), FIX_REQUIRED_LABEL];
  }

  // 3. The ledger PR, at most hourly while there is something to propose.
  if (isEmptyProposal(proposal)) return out;
  const summarize = (p) => ({ add: p.add.map((e) => e.id), renew: p.renew.map((e) => e.id), remove: p.remove.map((e) => e.id), next: p.next });
  let summary = summarize(proposal);
  if (!writer) {
    const res = await ledgerPrTick({ proposal, today, mode: 'shadow' });
    shadowLog('ledger_pr', hash(summary), { mutations: [{ op: 'ledger_pr', args: { branch: res.branch, add: summary.add, renew: summary.renew, remove: summary.remove } }], title: res.title });
    out.ledger = 'shadow';
    return out;
  }
  if (fl.ledgerCheckedAt && now - ms(fl.ledgerCheckedAt) < LEDGER_CHECK_MS) return out;
  fl.ledgerCheckedAt = iso(now);
  // The index can be a day old. Before a PR that adds or renews a quarantine,
  // check each issue it cites is still open and the operator's: a human
  // closing it means "fixed" or "not flaky".
  let recheck = false;
  for (const e of [...proposal.add, ...proposal.renew]) {
    const res = await t.gh.rest('GET', `repos/${t.repo}/issues/${e.issue}`);
    if (res.status !== 200) throw new Error(`flaky tests: issue ${e.issue} read failed (${res.status}) before the ledger PR`);
    if (res.body.state === 'open' && res.body.user?.login === viewer) continue;
    const key = flakeKey(e.runner, e.id);
    fl.index[key] = { ...(fl.index[key] ?? { issue: e.issue, labels: [] }), open: false, closedAt: res.body.closed_at ?? iso(now), since: null };
    recheck = true;
  }
  if (recheck) {
    proposal = propose();
    if (isEmptyProposal(proposal)) return out;
    summary = summarize(proposal);
  }
  const res = await ledgerPrTick({
    gh: t.gh,
    git,
    writer,
    checkoutDir: t.checkoutDir,
    repo: t.repo,
    proposal,
    today,
    mode: 'act',
    modeNow: t.modeNow,
    unenqueued: fl.unenqueued ?? null,
    onCreated: (pr) => {
      fl.unenqueued = pr;
      t.save();
    },
  });
  // Auto-merge landed (or the PR it was owed to is no longer the open one).
  if (res.status === 'opened' || (res.status === 'waiting' && (res.enqueued || res.pr !== fl.unenqueued))) fl.unenqueued = null;
  out.ledger = res.status;
  if (res.status === 'opened') {
    t.record({ actionId: `flake:ledger_pr:${res.branch}`, kind: 'ledger_pr', pr: res.pr, mutations: [{ op: 'ledger_pr', args: { branch: res.branch, add: summary.add, renew: summary.renew, remove: summary.remove } }], reasons: [], mode: t.mode, status: 'applied', source: 'flake', at: iso(now) });
  }
  return out;
}
