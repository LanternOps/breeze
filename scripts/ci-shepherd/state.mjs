// The tick's local state (W06b B3, #10750): state.json, the lock, and the
// append-only logs, all under one state dir owned by the single runner.
//
//   state.json      cursor, seen removals, breakers, pending act-mode intents,
//                   7 days of verdicts, the per-tick API call log …
//   lock            {token, at}; older than 15 min is stale and taken over
//   decisions.jsonl one line per decision applied or recorded (shadow)
//   sightings.jsonl flake sightings from completed CI runs (evidence.mjs)
import { closeSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { emptyBreakerState } from './breakers.mjs';

export const LOCK_STALE_MS = 15 * 60_000;
export const HOUR_MS = 3600_000;
export const TICK_CALL_CAP = 600;
export const HOURLY_CALL_CAP = 1500;

export const emptyState = () => ({
  v: 1,
  cursor: null,
  ingestCursor: null,
  seen: {},
  failures: {},
  verdicts: [],
  breakers: emptyBreakerState(),
  records: [],
  parked: [],
  pending: [],
  selfOps: [],
  stuck: {},
  stuckCount: {},
  stuckHolds: {},
  clearedBreakers: [],
  breakerEvidence: { mainRuns: [], queuePasses: [] },
  resumed: {},
  ingested: {},
  done: {},
  calls: [],
});

// { state, corrupt }. A state.json that does not parse is kept beside it as
// state.json.corrupt-<ms> and the tick starts over; `corrupt` names that file
// so the tick can report it. Markers on the PRs keep act mode from repeating
// a comment it already posted.
export function loadState(dir) {
  const path = join(dir, 'state.json');
  const text = readIfPresent(path);
  if (text === null) return { state: emptyState(), corrupt: null };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return { state: { ...emptyState(), ...parsed }, corrupt: null };
  } catch {
    const kept = `${path}.corrupt-${Date.now()}`;
    renameSync(path, kept);
    return { state: emptyState(), corrupt: kept };
  }
}

export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'state.json');
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, path);
}

// A killed writer can leave a last line without its newline; start a new
// line rather than glue this record onto the torn one.
export function appendJsonl(path, obj) {
  // One descriptor for the size check and the write: no gap between them.
  const fd = openSync(path, 'a+');
  try {
    let lead = '';
    const size = fstatSync(fd).size;
    if (size > 0) {
      const b = Buffer.alloc(1);
      readSync(fd, b, 0, 1, size - 1);
      if (b[0] !== 0x0a) lead = '\n';
    }
    writeSync(fd, `${lead}${JSON.stringify(obj)}\n`);
  } finally {
    closeSync(fd);
  }
}

// Read-or-null in one call; a separate existence check would race the read.
function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

export function readJsonl(path) {
  const text = readIfPresent(path);
  if (text === null) return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn last line from a killed tick; skip it.
    }
  }
  return out;
}

export function writeJsonl(path, list) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, list.map((x) => `${JSON.stringify(x)}\n`).join(''));
  renameSync(tmp, path);
}

// { ok: true, token } or { ok: false, heldSince }. The body is written to a
// temp file and linked/renamed into place, so a reader never sees a half
// lock. An unreadable lock counts as held until its mtime is stale.
export function acquireLock(dir, now, staleMs = LOCK_STALE_MS) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'lock');
  const token = randomUUID();
  const tmp = `${path}.${token}`;
  writeFileSync(tmp, JSON.stringify({ token, at: new Date(now).toISOString(), pid: process.pid }));
  try {
    try {
      // link() fails with EEXIST when a lock is there: atomic create.
      linkSync(tmp, path);
      return { ok: true, token };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let heldAt = NaN;
    try {
      heldAt = Date.parse(JSON.parse(readFileSync(path, 'utf8')).at);
    } catch {
      try {
        heldAt = statSync(path).mtimeMs;
      } catch {
        heldAt = NaN;
      }
    }
    if (!Number.isNaN(heldAt) && now - heldAt < staleMs) return { ok: false, heldSince: new Date(heldAt).toISOString() };
    renameSync(tmp, path);
    // Two takers of one stale lock: only the one whose token landed proceeds.
    const mine = JSON.parse(readFileSync(path, 'utf8')).token === token;
    return mine ? { ok: true, token, tookStale: Number.isNaN(heldAt) ? 'unreadable' : new Date(heldAt).toISOString() } : { ok: false, heldSince: 'contended' };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Renamed into place, or already gone.
    }
  }
}

export function releaseLock(dir, token) {
  const path = join(dir, 'lock');
  try {
    if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path);
  } catch {
    // Gone or replaced: not ours to remove.
  }
}

// Calls in the trailing hour, and this tick's budget: min(600, 1500 − used).
export function tickBudget(state, now) {
  state.calls = (state.calls ?? []).filter((c) => now - Date.parse(c.at) < HOUR_MS);
  const used = state.calls.reduce((s, c) => s + c.n, 0);
  return { used, budget: Math.max(0, Math.min(TICK_CALL_CAP, HOURLY_CALL_CAP - used)) };
}
