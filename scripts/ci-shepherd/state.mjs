// The tick's local state (W06b B3, #10750): state.json, the lock, and the
// append-only logs, all under one state dir owned by the single runner.
//
//   state.json      cursor, seen removals, breakers, pending act-mode intents,
//                   7 days of verdicts, the per-tick API call log …
//   lock            {token, at}; older than 15 min is stale and taken over
//   decisions.jsonl one line per decision applied or recorded (shadow)
//   sightings.jsonl flake sightings from completed CI runs (evidence.mjs)
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, closeSync } from 'node:fs';
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
  resumed: {},
  ingested: {},
  done: {},
  calls: [],
});

export function loadState(dir) {
  const path = join(dir, 'state.json');
  if (!existsSync(path)) return emptyState();
  const text = readFileSync(path, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep the bad file for a human; start over. Markers on the PRs keep act
    // mode from repeating a comment it already posted.
    renameSync(path, `${path}.corrupt-${Date.now()}`);
    return emptyState();
  }
  return { ...emptyState(), ...parsed };
}

export function saveState(dir, state) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'state.json');
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, path);
}

export function appendJsonl(path, obj) {
  appendFileSync(path, `${JSON.stringify(obj)}\n`);
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
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

// { ok: true, token } or { ok: false, heldSince }.
export function acquireLock(dir, now, staleMs = LOCK_STALE_MS) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'lock');
  const token = randomUUID();
  const body = JSON.stringify({ token, at: new Date(now).toISOString(), pid: process.pid });
  try {
    const fd = openSync(path, 'wx');
    writeFileSync(fd, body);
    closeSync(fd);
    return { ok: true, token };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  let held = null;
  try {
    held = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    held = null;
  }
  const at = held ? Date.parse(held.at) : NaN;
  if (!Number.isNaN(at) && now - at < staleMs) return { ok: false, heldSince: held.at };
  writeFileSync(path, body);
  return { ok: true, token, tookStale: held?.at ?? 'unreadable' };
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
