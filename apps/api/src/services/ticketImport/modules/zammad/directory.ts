import type { SourceHandle } from '../../moduleContract';
import { SourceAuthError, SourceHttpError } from '../../sourceFetch';
import { getUser, listPriorities, listStates, listUsers } from './api';
import { personOf, ZAMMAD_STATE_TYPE_BY_ID, ZammadShapeError, type ZammadPerson, type ZammadStateInfo } from './shapes';

/**
 * The source's directory a load names people and states from (#8313 W5; spec
 * 2026-10-19 §6.2 "people"): states with their types, priorities, and users,
 * cached per process for 30 minutes per source. The users index is paged
 * once (1000 a page); a user it does not hold (created since) is read on its
 * own and cached too, and one the source no longer has is cached as null.
 *
 * Keyed by source id and base URL, so two sources never share an entry;
 * bounded to a few sources. Only the fields a conversion names are kept
 * (shapes.ts `ZammadPerson`).
 */

export const ZAMMAD_DIRECTORY_TTL_MS = 30 * 60_000;
const MAX_SOURCES = 16;

type Entry = {
  loadedAt: number;
  states: Map<number, ZammadStateInfo> | null;
  priorities: Map<number, string> | null;
  /** null until the users index has been read. */
  users: Map<number, ZammadPerson | null> | null;
  /** Rows skipped as unreadable, by list, not yet reported by a load. */
  invalidPending: Record<string, number>;
};

const CACHE = new Map<string, Entry>();

function keyOf(src: SourceHandle<unknown>): string {
  return `${src.sourceId}\n${src.baseUrl}`;
}

/** Tests only. */
export function clearZammadDirectoryCache(): void {
  CACHE.clear();
}

function entryOf(src: SourceHandle<unknown>, now: number): Entry {
  const key = keyOf(src);
  const existing = CACHE.get(key);
  if (existing && now - existing.loadedAt < ZAMMAD_DIRECTORY_TTL_MS) return existing;
  CACHE.delete(key);
  while (CACHE.size >= MAX_SOURCES) CACHE.delete(CACHE.keys().next().value!);
  const entry: Entry = { loadedAt: now, states: null, priorities: null, users: null, invalidPending: {} };
  CACHE.set(key, entry);
  return entry;
}

function countInvalid(entry: Entry, list: string, invalid: number): void {
  if (invalid > 0) entry.invalidPending[list] = (entry.invalidPending[list] ?? 0) + invalid;
}

/**
 * The directory rows skipped as unreadable since the last call, by list
 * (`users`, `states`, `priorities`): a load hands them to its conversion,
 * which counts them once in the run report. A bad row never fails a load.
 */
export function takeZammadInvalidRows(src: SourceHandle<unknown>): Record<string, number> {
  const entry = CACHE.get(keyOf(src));
  if (!entry) return {};
  const out = entry.invalidPending;
  entry.invalidPending = {};
  return out;
}

/** A state type by name, else the seeded type of its id (Z12). */
export function stateTypeName(stateTypeId: number, named: string | null | undefined): string {
  const name = named?.trim().toLowerCase();
  if (name) return name;
  return ZAMMAD_STATE_TYPE_BY_ID.get(stateTypeId) ?? 'unknown';
}

async function readStates(src: SourceHandle<unknown>, entry: Entry): Promise<Map<number, ZammadStateInfo>> {
  const { rows, invalid } = await listStates(src);
  countInvalid(entry, 'states', invalid);
  const types = new Map(rows.map((s) => [s.id, stateTypeName(s.state_type_id, s.state_type)]));
  return new Map(rows.map((s) => [s.id, {
    id: s.id,
    name: s.name,
    type: types.get(s.id)!,
    // undefined: the list does not say (the seeded reading applies); null: no next state.
    nextStateType: s.next_state_id === undefined ? undefined : s.next_state_id === null ? null : types.get(s.next_state_id) ?? null,
  }]));
}

/** A ticket's state with its type; the states are read again once for a state created since. */
export async function zammadState(src: SourceHandle<unknown>, stateId: number, now: number = Date.now()): Promise<ZammadStateInfo | null> {
  const entry = entryOf(src, now);
  if (!entry.states) entry.states = await readStates(src, entry);
  let state = entry.states.get(stateId);
  if (!state) {
    entry.states = await readStates(src, entry);
    state = entry.states.get(stateId);
  }
  return state ?? null;
}

export async function zammadPriorityName(src: SourceHandle<unknown>, priorityId: number, now: number = Date.now()): Promise<string | null> {
  const entry = entryOf(src, now);
  if (!entry.priorities || !entry.priorities.has(priorityId)) {
    const { rows, invalid } = await listPriorities(src);
    countInvalid(entry, 'priorities', invalid);
    entry.priorities = new Map(rows.map((p) => [p.id, p.name]));
  }
  return entry.priorities.get(priorityId) ?? null;
}

/**
 * The people with these ids; null for a user the source answers 404 (or 403)
 * for, or one whose record it cannot read (skipped and counted: a bad user
 * row never fails a load).
 */
export async function zammadPeople(
  src: SourceHandle<unknown>,
  ids: Iterable<number>,
  now: number = Date.now(),
): Promise<Map<number, ZammadPerson | null>> {
  const entry = entryOf(src, now);
  if (!entry.users) {
    const { rows, invalid } = await listUsers(src);
    countInvalid(entry, 'users', invalid);
    entry.users = new Map(rows.map((u) => [u.id, personOf(u)]));
  }
  const out = new Map<number, ZammadPerson | null>();
  for (const id of new Set(ids)) {
    if (!entry.users.has(id)) {
      try {
        entry.users.set(id, personOf(await getUser(src, id)));
      } catch (error) {
        if (error instanceof ZammadShapeError) countInvalid(entry, 'users', 1);
        else if (!(error instanceof SourceHttpError) || error instanceof SourceAuthError || ![403, 404].includes(error.status)) throw error;
        entry.users.set(id, null);
      }
    }
    out.set(id, entry.users.get(id) ?? null);
  }
  return out;
}
