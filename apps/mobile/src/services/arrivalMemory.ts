import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * What the arrival prompt remembers between launches: which sites the
 * technician waved away, where they last stopped, which candidate they picked
 * last time, and recent "away from site" reads for the stop prompt.
 *
 * Site ids and timestamps only — never a coordinate. Entries older than 24 h
 * are dropped on every write, and a corrupted blob reads as empty.
 */
export const ARRIVAL_MEMORY_KEY = 'breeze.arrival.v1';
const RETENTION_MS = 24 * 3600_000;
const FAR_READS_KEPT = 3;

export type FarRead = { atMs: number; distanceM: number };

export type ArrivalMemory = {
  dismissedAt: Record<string, number>;
  lastStopAt: Record<string, number>;
  lastPick: Record<string, string>;
};

type Stored = ArrivalMemory & {
  /** Keyed by running-entry id; each value is oldest-first. */
  farReads: Record<string, FarRead[]>;
  /** When each lastPick group was written, so it can be pruned. */
  pickAt: Record<string, number>;
};

const EMPTY = (): Stored => ({
  dismissedAt: {},
  lastStopAt: {},
  lastPick: {},
  farReads: {},
  pickAt: {},
});

function numberMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function farReadMap(value: unknown): Record<string, FarRead[]> {
  const out: Record<string, FarRead[]> = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const [k, list] of Object.entries(value)) {
    if (!Array.isArray(list)) continue;
    const reads = list.filter(
      (r): r is FarRead =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as FarRead).atMs === 'number' &&
        typeof (r as FarRead).distanceM === 'number'
    );
    if (reads.length > 0) out[k] = reads;
  }
  return out;
}

async function load(): Promise<Stored> {
  try {
    const raw = await AsyncStorage.getItem(ARRIVAL_MEMORY_KEY);
    if (raw === null) return EMPTY();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      dismissedAt: numberMap(parsed.dismissedAt),
      lastStopAt: numberMap(parsed.lastStopAt),
      lastPick: stringMap(parsed.lastPick),
      farReads: farReadMap(parsed.farReads),
      pickAt: numberMap(parsed.pickAt),
    };
  } catch {
    return EMPTY();
  }
}

function pruneNumbers(map: Record<string, number>, nowMs: number): Record<string, number> {
  return Object.fromEntries(Object.entries(map).filter(([, at]) => nowMs - at < RETENTION_MS));
}

function prune(mem: Stored, nowMs: number): Stored {
  const pickAt = pruneNumbers(mem.pickAt, nowMs);
  return {
    dismissedAt: pruneNumbers(mem.dismissedAt, nowMs),
    lastStopAt: pruneNumbers(mem.lastStopAt, nowMs),
    lastPick: Object.fromEntries(Object.entries(mem.lastPick).filter(([k]) => k in pickAt)),
    pickAt,
    farReads: Object.fromEntries(
      Object.entries(mem.farReads).filter(([, reads]) => {
        const newest = reads[reads.length - 1];
        return newest !== undefined && nowMs - newest.atMs < RETENTION_MS;
      })
    ),
  };
}

async function save(mem: Stored, nowMs: number): Promise<void> {
  try {
    await AsyncStorage.setItem(ARRIVAL_MEMORY_KEY, JSON.stringify(prune(mem, nowMs)));
  } catch {
    // Memory is a convenience: losing it re-shows a prompt, never loses work.
  }
}

export async function readArrivalMemory(nowMs: number): Promise<ArrivalMemory> {
  const pruned = prune(await load(), nowMs);
  return {
    dismissedAt: pruned.dismissedAt,
    lastStopAt: pruned.lastStopAt,
    lastPick: pruned.lastPick,
  };
}

export async function recordDismiss(siteIds: string[], nowMs: number): Promise<void> {
  const mem = await load();
  for (const id of siteIds) mem.dismissedAt[id] = nowMs;
  await save(mem, nowMs);
}

export async function recordStopAtSite(siteId: string, nowMs: number): Promise<void> {
  const mem = await load();
  mem.lastStopAt[siteId] = nowMs;
  await save(mem, nowMs);
}

/** `groupKey` = sorted candidate ids joined by ',' (see arrivalMatch.groupKey). */
export async function recordPick(groupKey: string, siteId: string, nowMs: number): Promise<void> {
  const mem = await load();
  mem.lastPick[groupKey] = siteId;
  mem.pickAt[groupKey] = nowMs;
  await save(mem, nowMs);
}

export async function readFarReads(entryKey: string): Promise<FarRead[]> {
  return (await load()).farReads[entryKey] ?? [];
}

export async function recordFarRead(entryKey: string, read: FarRead): Promise<void> {
  const mem = await load();
  mem.farReads[entryKey] = [...(mem.farReads[entryKey] ?? []), read].slice(-FAR_READS_KEPT);
  await save(mem, read.atMs);
}

export async function clearFarReads(entryKey: string): Promise<void> {
  const mem = await load();
  if (!(entryKey in mem.farReads)) return;
  delete mem.farReads[entryKey];
  await save(mem, Date.now());
}

/** Sign-out: the memory is account-scoped (site ids the previous technician dismissed). */
export async function clearArrivalMemory(): Promise<void> {
  await AsyncStorage.removeItem(ARRIVAL_MEMORY_KEY);
}
