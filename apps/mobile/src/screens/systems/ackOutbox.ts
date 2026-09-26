import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Durable outbox for held and in-flight alert acknowledges (#3919).
 *
 * The undo window (`undoAck`) and the bulk request (`acknowledgeAlerts`) both
 * live in memory. On `background` the screen flushes the held batch, and the
 * request then awaits SecureStore, the CSRF token, the installation id and the
 * server URL before it reaches `fetch`. If iOS suspends or reclaims the process
 * during those awaits, the batch is gone: the undo ref is already empty, so the
 * timer, the unmount cleanup and every later lifecycle event correctly send
 * nothing. The toast had already said "acknowledged".
 *
 * So an acknowledge is written here when its undo window OPENS, before any
 * step that can lose it, and it leaves only on a settled outcome:
 *
 *   - Undo tap: removed. It was never sent.
 *   - Server answered: `updatedIds`/`skippedIds` (confirmed) and `failedIds`
 *     (refused, and already restored on screen with an error toast) are
 *     removed. A request refused outright with a client-error status is
 *     removed the same way; replaying it cannot succeed.
 *   - Transport-unknown (timeout, dropped connection, unusable body, process
 *     killed mid-await): KEPT, and replayed on the next mount or foreground.
 *
 * Replaying is safe because the server's acknowledge is idempotent. `POST
 * /alerts/bulk` acknowledges only rows still `active`, under an
 * `UPDATE … WHERE status = 'active'` precondition, and reports anything else as
 * skipped without emitting events; nothing in the API moves an alert back to
 * `active`. So re-sending an id the server already processed is a no-op, and
 * the ambiguous-timeout ids from #3727 are never resurrected as visible rows:
 * replay only ever re-sends them, it never un-hides them.
 *
 * Two limits on replay:
 *
 *   - Owner. An entry records the account that asked for it and replays only
 *     under that account. Another account's entries are never sent with this
 *     account's credentials.
 *   - Age. An entry older than `ACK_OUTBOX_TTL_MS` is dropped, not sent. A
 *     batch from hours ago would silently acknowledge an alert that may have
 *     escalated since; after the TTL the row simply shows again and the
 *     operator decides. The screen says how many were dropped.
 */

export const ACK_OUTBOX_KEY = 'breeze.ackOutbox.v1';

/** Replay window. Older held acknowledges are dropped, not sent. */
export const ACK_OUTBOX_TTL_MS = 60 * 60 * 1000;

export interface OutboxEntry {
  readonly alertId: string;
  /** User id of the account that asked for the acknowledge. */
  readonly owner: string;
  /** Epoch ms of the most recent acknowledge of this id. */
  readonly queuedAt: number;
}

/**
 * Same shape as `BulkAckOutcome` in `services/api`, restated so this module
 * does not pull the whole API client (SecureStore, Expo) into its imports.
 */
export interface AckOutcome {
  acknowledged: string[];
  failed: string[];
  unknown: string[];
  errors: unknown[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.alertId === 'string' &&
    typeof v.owner === 'string' &&
    typeof v.queuedAt === 'number' &&
    Number.isFinite(v.queuedAt)
  );
}

/** Parse the stored blob. Anything unreadable is treated as empty. */
export function parseOutbox(raw: string | null): OutboxEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isEntry).map((e) => ({
    alertId: e.alertId,
    owner: e.owner,
    queuedAt: e.queuedAt,
  }));
}

/**
 * Add one entry per id. An id already present is refreshed rather than
 * duplicated: the newest acknowledge is the intent the TTL should measure.
 */
export function addEntries(
  entries: readonly OutboxEntry[],
  ids: readonly string[],
  owner: string,
  now: number
): OutboxEntry[] {
  const incoming = new Set(ids);
  const kept = entries.filter((e) => !incoming.has(e.alertId));
  return [...kept, ...[...incoming].map((alertId) => ({ alertId, owner, queuedAt: now }))];
}

export function removeEntries(
  entries: readonly OutboxEntry[],
  ids: readonly string[]
): OutboxEntry[] {
  if (ids.length === 0) return [...entries];
  const drop = new Set(ids);
  return entries.filter((e) => !drop.has(e.alertId));
}

export interface ReplayPlan {
  /** This owner's unexpired ids: send them. */
  readonly replay: string[];
  /** This owner's ids past the TTL: dropped, never sent. */
  readonly expired: string[];
  /** What the outbox should hold afterwards. */
  readonly keep: OutboxEntry[];
}

/**
 * Decide what a replay sends.
 *
 * Replayed ids stay in `keep` — they leave only when `sendAcknowledge` gets a
 * settled answer, so a replay that is itself interrupted is not lost either.
 * Expired entries of ANY owner are pruned so the outbox cannot grow without
 * bound, but only the current owner's expiries are reported, since only those
 * rows are on this operator's screen.
 */
export function planReplay(
  entries: readonly OutboxEntry[],
  owner: string | null,
  now: number,
  ttlMs: number = ACK_OUTBOX_TTL_MS
): ReplayPlan {
  const replay: string[] = [];
  const expired: string[] = [];
  const keep: OutboxEntry[] = [];
  for (const e of entries) {
    const isExpired = now - e.queuedAt > ttlMs;
    const mine = owner !== null && e.owner === owner;
    if (isExpired) {
      if (mine) expired.push(e.alertId);
      continue;
    }
    keep.push(e);
    if (mine) replay.push(e.alertId);
  }
  return { replay, expired, keep };
}

/**
 * True for a request the server refused on its merits, where a replay would
 * get the same answer (400, 403, 404 "No accessible alerts found", …).
 *
 * Deliberately NOT permanent: 401 (a re-login fixes it), 408/425/429 (try
 * again later), 5xx, and anything without a status (a transport failure).
 */
export function isPermanentAckError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { statusCode?: unknown }).statusCode;
  if (typeof status !== 'number') return false;
  if (status < 400 || status >= 500) return false;
  return status !== 401 && status !== 408 && status !== 425 && status !== 429;
}

/**
 * Ids whose outcome is final, and which therefore leave the outbox.
 *
 * `unknown` ids stay — unless the whole request was refused with a permanent
 * status, in which case they are unknown only in the sense that
 * `acknowledgeAlerts` reports every thrown request that way; retrying would
 * loop until the TTL.
 */
export function settledIds(outcome: AckOutcome): string[] {
  const settled = [...outcome.acknowledged, ...outcome.failed];
  const refusedOutright =
    outcome.unknown.length > 0 && outcome.errors.length > 0 && outcome.errors.every(isPermanentAckError);
  if (refusedOutright) settled.push(...outcome.unknown);
  return settled;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Every read-modify-write runs on this chain. The screen records, clears and
 * replays from independent callbacks, and two interleaved read-then-write
 * sequences would otherwise drop whichever wrote first.
 */
let chain: Promise<unknown> = Promise.resolve();

function serialised<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

async function load(): Promise<OutboxEntry[]> {
  return parseOutbox(await AsyncStorage.getItem(ACK_OUTBOX_KEY));
}

async function save(entries: readonly OutboxEntry[]): Promise<void> {
  if (entries.length === 0) await AsyncStorage.removeItem(ACK_OUTBOX_KEY);
  else await AsyncStorage.setItem(ACK_OUTBOX_KEY, JSON.stringify(entries));
}

/** Resolve false instead of rejecting: durability is best effort, acknowledging is not. */
function mutate(apply: (entries: OutboxEntry[]) => OutboxEntry[]): Promise<boolean> {
  return serialised(async () => {
    try {
      await save(apply(await load()));
      return true;
    } catch {
      return false;
    }
  });
}

export function readOutbox(): Promise<OutboxEntry[]> {
  return serialised(() => load().catch(() => []));
}

/** Record ids whose undo window just opened. Resolves false if storage failed. */
export function recordHeldAcks(
  ids: readonly string[],
  owner: string,
  now: number = Date.now()
): Promise<boolean> {
  if (ids.length === 0) return Promise.resolve(true);
  return mutate((entries) => addEntries(entries, ids, owner, now));
}

/** Remove ids that were undone or settled. Resolves false if storage failed. */
export function clearAcks(ids: readonly string[]): Promise<boolean> {
  if (ids.length === 0) return Promise.resolve(true);
  return mutate((entries) => removeEntries(entries, ids));
}

/**
 * Prune expired entries and return what to replay for `owner`. The replayed
 * ids stay stored until `sendAcknowledge` settles them.
 */
export function takeReplay(
  owner: string | null,
  now: number = Date.now()
): Promise<{ replay: string[]; expired: string[] }> {
  return serialised(async () => {
    try {
      const plan = planReplay(await load(), owner, now);
      try {
        await save(plan.keep);
      } catch {
        // Could not prune. Still replay: the entries remain and the next
        // replay re-derives the same plan.
      }
      return { replay: plan.replay, expired: plan.expired };
    } catch {
      return { replay: [], expired: [] };
    }
  });
}

/**
 * Send an acknowledge and remove whatever it settled from the outbox.
 *
 * The ids are cleared only AFTER the answer arrives, so an interrupted request
 * leaves them on disk for the next replay. `send` is `acknowledgeAlerts`, which
 * never rejects; a rejection is still treated as all-unknown rather than
 * trusted, since treating it as settled would drop the batch.
 */
export async function sendAcknowledge(
  send: (ids: string[]) => Promise<AckOutcome>,
  ids: readonly string[]
): Promise<AckOutcome> {
  let result: AckOutcome;
  try {
    result = await send([...ids]);
  } catch (err) {
    result = { acknowledged: [], failed: [], unknown: [...ids], errors: [err] };
  }
  await clearAcks(settledIds(result));
  return result;
}
