// Deterministic flaky-ledger proposals (W06c C2, #10750).
//
// This is the only W06 path that can weaken a gate: an entry in
// `.github/flaky-tests.json` lets a test fail both attempts without failing
// its job (W01, flaky-ledger.mjs). So an add needs corroboration and every
// unknown holds it closed:
//
//   add     the test is not in the ledger, has an open flaky-test issue, and
//           in the last 7 days has ≥ 3 sightings, from ≥ 2 distinct PRs, at
//           least one of them threatening the queue (fail_fail, or seen in a
//           merge_group run) and at least one showing it can pass on the same
//           code (fail_pass or fail_other: a test that only ever failed both
//           attempts looks deterministic, not flaky); no main_broken breaker
//           (suspected or confirmed) names it; its file exists at main; and it
//           has < 60 quarantine days. The entry runs 14 days, cut to what is
//           left of the 60. `covers` is never added.
//   renew   an entry expiring within 3 days, with fresh flake evidence (a
//           fail_pass or fail_other in the last 7 days), an open issue, no
//           main_broken breaker naming it, and room for 14 more days under
//           the 60-day cap. It restarts today for 14 days.
//   remove  today is past `expires`; or the entry is ≥ 14 days old and the
//           test had no sighting in the last 14 days, while the evidence
//           store covers those 14 days (`evidenceSince`).
//   fixRequired  tests that would be added or renewed but hit the 60-day
//           cap: they get the `flaky-fix-required` label and are never
//           renewed again.
//
// "In the last N days" counts UTC calendar days: today and the N − 1 before.
import { validateLedger } from '../../.github/scripts/flaky-ledger.mjs';
import { flakeKey } from './flake-issues.mjs';

export const ADD_MIN_SIGHTINGS = 3;
export const ADD_MIN_PRS = 2;
export const WINDOW_DAYS = 7;
export const ENTRY_DAYS = 14;
export const RENEW_WITHIN_DAYS = 3;
export const SILENT_DAYS = 14;
export const CAP_DAYS = 60;

const DAY = 86_400_000;
const dayNumber = (d) => Date.parse(`${d}T00:00:00Z`) / DAY;
const dayOf = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const FLAKY_KINDS = new Set(['fail_pass', 'fail_other']);
const BLOCKING_BREAKER = new Set(['suspected', 'confirmed']);
const byRunnerId = (a, b) => (a.runner === b.runner ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.runner < b.runner ? -1 : 1);

// ledger: Entry[] at main. records: [{ runner, id, file, issue (open issue
// number, or null), quarantine_days, sightings }]. breakers: Breaker[]
// (breakers.mjs). fileExists(path) answers at main. evidenceSince: when the
// evidence store started (ISO), default: it covers everything.
export function proposeLedger({ ledger, records, breakers = [], today, fileExists, evidenceSince = null }) {
  const t = dayNumber(today);
  if (Number.isNaN(t)) throw new Error(`proposeLedger: bad today ${today}`);
  const errors = validateLedger(ledger);
  if (errors.length) throw new Error(`proposeLedger: the ledger at main is invalid: ${errors.join('; ')}`);
  const recordOf = new Map(records.map((r) => [flakeKey(r.runner, r.id), r]));
  const daysAgo = (s) => t - Math.floor(Date.parse(s.at) / DAY);
  const within = (r, days) => (r?.sightings ?? []).filter((s) => daysAgo(s) >= 0 && daysAgo(s) < days);
  const brokenOnMain = (id) => breakers.some((b) => b.kind === 'main_broken' && BLOCKING_BREAKER.has(b.status) && b.key === id);
  const silenceKnown = evidenceSince === null || Date.parse(evidenceSince) <= (t - SILENT_DAYS + 1) * DAY;
  const evidence = {};
  const note = (key, r) => {
    const s7 = within(r, WINDOW_DAYS);
    const kinds = { fail_pass: 0, fail_fail: 0, fail_other: 0 };
    for (const s of s7) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
    evidence[key] = { sightings7: s7.length, kinds, prs: new Set(s7.map((s) => s.pr).filter((p) => p !== null && p !== undefined)).size };
  };

  const out = { next: [], add: [], renew: [], remove: [], fixRequired: [], waitingIssue: [], evidence };
  const inLedger = new Set();
  for (const e of ledger) {
    const key = flakeKey(e.runner, e.id);
    inLedger.add(key);
    const r = recordOf.get(key);
    const expires = dayNumber(e.expires);
    if (t > expires) {
      out.remove.push(e);
      note(key, r);
      continue;
    }
    if (silenceKnown && dayNumber(e.added) <= t - SILENT_DAYS && within(r, SILENT_DAYS).length === 0) {
      out.remove.push(e);
      note(key, r);
      continue;
    }
    const fresh = within(r, WINDOW_DAYS).some((s) => FLAKY_KINDS.has(s.kind));
    if (expires <= t + RENEW_WITHIN_DAYS && fresh && r?.issue && !brokenOnMain(e.id)) {
      if (r.quarantine_days + ENTRY_DAYS <= CAP_DAYS) {
        const renewed = { ...e, issue: r.issue, added: today, expires: dayOf(t + ENTRY_DAYS) };
        out.renew.push(renewed);
        out.next.push(renewed);
        note(key, r);
        continue;
      }
      out.fixRequired.push(key);
    }
    out.next.push(e);
  }

  for (const r of [...records].sort(byRunnerId)) {
    const key = flakeKey(r.runner, r.id);
    if (inLedger.has(key)) continue;
    const s7 = within(r, WINDOW_DAYS);
    const prs = new Set(s7.map((s) => s.pr).filter((p) => p !== null && p !== undefined));
    const corroborated =
      s7.length >= ADD_MIN_SIGHTINGS &&
      prs.size >= ADD_MIN_PRS &&
      s7.some((s) => s.kind === 'fail_fail' || s.event === 'merge_group') &&
      s7.some((s) => FLAKY_KINDS.has(s.kind));
    if (!corroborated || brokenOnMain(r.id) || !r.file || !fileExists(r.file)) continue;
    if (r.quarantine_days >= CAP_DAYS) {
      out.fixRequired.push(key);
      continue;
    }
    if (!r.issue) {
      out.waitingIssue.push(key);
      continue;
    }
    const entry = { id: r.id, runner: r.runner, file: r.file, issue: r.issue, added: today, expires: dayOf(t + Math.min(ENTRY_DAYS, CAP_DAYS - r.quarantine_days)) };
    // An id the ledger cannot hold (a Go subtest, a failed suite) is skipped.
    if (validateLedger([entry]).length) continue;
    out.add.push(entry);
    out.next.push(entry);
    note(key, r);
  }

  out.next.sort(byRunnerId);
  const bad = validateLedger(out.next);
  if (bad.length) throw new Error(`proposeLedger: the proposed ledger is invalid: ${bad.join('; ')}`);
  return out;
}

export const isEmptyProposal = (p) => !p || (p.add.length === 0 && p.renew.length === 0 && p.remove.length === 0);
