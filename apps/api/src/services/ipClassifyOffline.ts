/**
 * Offline IP-classification baseline (#11698): loads and refreshes the three
 * datasets behind classifyWithOfflineData, used when no keyed provider is
 * configured.
 *
 *   - Tor exit list   — refreshed daily; bundled snapshot until the first
 *                       download. A download replaces the list (exits churn),
 *                       but one smaller than 80% of the last accepted list is
 *                       rejected as truncated or tampered.
 *   - Hosting ASNs    — refreshed weekly from a commit-pinned default URL. A
 *                       download is UNIONED with the bundled snapshot: it can
 *                       add hosting ASNs, never remove one.
 *   - ASN database    — refreshed weekly; NOT bundled (downloaded at runtime
 *                       and cached on local disk). Same 80% floor against the
 *                       last accepted copy.
 *
 * Freshness is what lets a result clear the promotion gate: only when all
 * three sources come from an accepted download within their maximum age
 * (refresh interval plus the same again as grace) does a lookup return the
 * 'offline' marker. The snapshots alone, a stale download, or a rejected
 * refresh all yield 'offline-partial', which keeps blocking. A rejected
 * download keeps the last good data AND its age, so it ages out rather than
 * looking fresh.
 *
 * Downloads are https-only (redirects followed manually, and only to https),
 * with a timeout and a size cap. A failure is logged once per attempt and
 * retried at most hourly. Nothing runs at boot: the first classification
 * triggers the loads, and a lookup only waits for an in-flight load when its
 * caller asks it to.
 *
 * Each process holds its own copy (the lookups are in-memory). The loader
 * publishes a small status record to Redis so the admin trust page, which may
 * be served by a different process than the abuse-signals worker that
 * classifies, can show what the classifier actually has.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable, Transform, pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';

import { ipClassifyAsnDbUrl, ipClassifyHostingAsnUrl, ipClassifyTorListUrl } from '../config/env';
import { HOSTING_ASN_SNAPSHOT, HOSTING_ASN_SNAPSHOT_DATE } from './ipClassifyData/hostingAsnSnapshot';
import { TOR_EXIT_SNAPSHOT, TOR_EXIT_SNAPSHOT_DATE } from './ipClassifyData/torExitSnapshot';
import {
  AsnTableBuilder,
  classifyWithOfflineData,
  parseHostingAsnList,
  parseTorExitList,
  type AsnTable,
  type IpClassification,
} from './ipClassifyOfflineData';
import { getRedis } from './redis';

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const TOR_TTL_MS = DAY_MS;
const LIST_TTL_MS = 7 * DAY_MS;
/** Refresh interval plus the same again as grace. */
export const TOR_MAX_AGE_MS = 2 * TOR_TTL_MS;
export const LIST_MAX_AGE_MS = 2 * LIST_TTL_MS;
const RETRY_AFTER_FAILURE_MS = HOUR_MS;

const SMALL_DOWNLOAD_TIMEOUT_MS = 15_000;
const ASN_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 3;
const TOR_MAX_BYTES = 4 * 1024 * 1024;
const HOSTING_MAX_BYTES = 2 * 1024 * 1024;
const ASN_MAX_BYTES = 64 * 1024 * 1024;
const ASN_MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;

/**
 * Integrity floors. A download smaller than the absolute minimum, or smaller
 * than SHRINK_FLOOR of the last accepted copy (the snapshot when nothing was
 * downloaded yet), is treated as truncated or tampered and rejected.
 */
const SHRINK_FLOOR = 0.8;
const TOR_MIN_ENTRIES = 50;
const HOSTING_MIN_ENTRIES = 50;
const ASN_MIN_RANGES = 10_000;

export const OFFLINE_STATUS_REDIS_KEY = 'ipclass:offline:status:v1';
const STATUS_TTL_SECONDS = 8 * 24 * 60 * 60;

type SourceKind = 'snapshot' | 'download' | 'disk' | 'unavailable';

export type OfflineSourceStatus = {
  source: SourceKind;
  entries: number;
  updatedAt: string | null;
  lastError: string | null;
};

export type OfflineClassifierStatus = {
  tor: OfflineSourceStatus;
  hosting: OfflineSourceStatus;
  asn: OfflineSourceStatus;
  /** True when every source is a fresh download, i.e. lookups can clear the gate. */
  current: boolean;
  reportedAt: string;
};

type SourceState<T> = {
  value: T;
  source: SourceKind;
  entries: number;
  /** When the data was produced: the snapshot date, the accepted download, or the disk cache mtime. */
  updatedAt: Date | null;
  lastError: string | null;
  nextAttemptAt: number;
  inflight: Promise<void> | null;
};

type State = {
  tor: SourceState<ReadonlySet<string>>;
  hosting: SourceState<ReadonlySet<number>>;
  asn: SourceState<AsnTable | null>;
  /** True once ensureOfflineData has run in this process. */
  touched: boolean;
};

const SNAPSHOT_HOSTING: ReadonlySet<number> = new Set(HOSTING_ASN_SNAPSHOT);

// Per-user directory, created 0700 and verified before use, so another local
// user cannot plant a database file for this process to load.
let cacheDir = join(tmpdir(), `breeze-ip-classify-${process.getuid?.() ?? 'user'}`);

async function privateCacheDir(): Promise<string | null> {
  try {
    await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(cacheDir);
    const uid = process.getuid?.();
    if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
      console.warn('[IPClassify] the ASN cache directory is not private to this user; not using it');
      return null;
    }
    return cacheDir;
  } catch (error) {
    console.warn(`[IPClassify] ASN cache directory unavailable: ${errorText(error)}`);
    return null;
  }
}
let state = initialState();

function snapshotDate(value: string): Date | null {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function initialState(): State {
  const tor = parseTorExitList(TOR_EXIT_SNAPSHOT);
  return {
    tor: {
      value: tor, source: 'snapshot', entries: tor.size, updatedAt: snapshotDate(TOR_EXIT_SNAPSHOT_DATE),
      lastError: null, nextAttemptAt: 0, inflight: null,
    },
    hosting: {
      value: SNAPSHOT_HOSTING, source: 'snapshot', entries: SNAPSHOT_HOSTING.size,
      updatedAt: snapshotDate(HOSTING_ASN_SNAPSHOT_DATE), lastError: null, nextAttemptAt: 0, inflight: null,
    },
    asn: {
      value: null, source: 'unavailable', entries: 0, updatedAt: null,
      lastError: null, nextAttemptAt: 0, inflight: null,
    },
    touched: false,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFresh(slot: SourceState<unknown>, maxAgeMs: number, now: number): boolean {
  if (slot.source !== 'download' && slot.source !== 'disk') return false;
  if (!slot.updatedAt) return false;
  const age = now - slot.updatedAt.getTime();
  return age >= 0 && age <= maxAgeMs;
}

/** All three sources are accepted downloads within their maximum age. */
function dataIsCurrent(now = Date.now()): boolean {
  return state.asn.value !== null
    && isFresh(state.tor, TOR_MAX_AGE_MS, now)
    && isFresh(state.hosting, LIST_MAX_AGE_MS, now)
    && isFresh(state.asn, LIST_MAX_AGE_MS, now);
}

function minimumEntries(absolute: number, reference: number): number {
  return Math.max(absolute, Math.floor(reference * SHRINK_FLOOR));
}

/**
 * https only. Redirects are followed by hand so that a hop to plain http is
 * refused before any request is sent to it.
 */
async function download(url: string, timeoutMs: number, maxBytes: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (new URL(target).protocol !== 'https:') throw new Error('refusing a non-https URL');
      const response = await fetch(target, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'user-agent': 'breeze-rmm-ip-classify' },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`HTTP ${response.status} without a location`);
        target = new URL(location, target).toString();
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`response larger than ${maxBytes} bytes`);
      return await readCapped(response, maxBytes, controller);
    }
    throw new Error(`more than ${MAX_REDIRECTS} redirects`);
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the body chunk by chunk and aborts as soon as it passes the cap. */
async function readCapped(response: Response, maxBytes: number, controller: AbortController): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      controller.abort();
      throw new Error(`response larger than ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function publishStatus(): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(OFFLINE_STATUS_REDIS_KEY, JSON.stringify(localStatus()), 'EX', STATUS_TTL_SECONDS);
  } catch (error) {
    // Status display only; the classifier itself does not depend on Redis.
    console.warn(`[IPClassify] could not publish the offline classifier status: ${errorText(error)}`);
  }
}

function sourceStatus(source: SourceState<unknown>): OfflineSourceStatus {
  return {
    source: source.source,
    entries: source.entries,
    updatedAt: source.updatedAt?.toISOString() ?? null,
    lastError: source.lastError,
  };
}

function localStatus(): OfflineClassifierStatus {
  return {
    tor: sourceStatus(state.tor),
    hosting: sourceStatus(state.hosting),
    asn: sourceStatus(state.asn),
    current: dataIsCurrent(),
    reportedAt: new Date().toISOString(),
  };
}

/**
 * Runs one refresh of a slot. `accept` turns the downloaded body into the new
 * value or throws to reject it; a rejection keeps the previous value and its
 * updatedAt (so freshness does not advance) and schedules a retry.
 */
function refreshSlot<T>(
  slot: SourceState<T>,
  url: string | null,
  label: string,
  ttlMs: number,
  load: () => Promise<{ value: T; entries: number; source: SourceKind; updatedAt: Date; body?: Buffer } | null>,
  afterAccept?: (body: Buffer) => Promise<void>,
): void {
  if (!url || slot.inflight || Date.now() < slot.nextAttemptAt) return;
  slot.inflight = (async () => {
    try {
      const loaded = await load();
      if (!loaded) return;
      slot.value = loaded.value;
      slot.source = loaded.source;
      slot.entries = loaded.entries;
      slot.updatedAt = loaded.updatedAt;
      slot.lastError = null;
      slot.nextAttemptAt = loaded.updatedAt.getTime() + ttlMs;
      if (loaded.body && afterAccept) await afterAccept(loaded.body);
    } catch (error) {
      slot.lastError = errorText(error);
      slot.nextAttemptAt = Date.now() + RETRY_AFTER_FAILURE_MS;
      console.warn(`[IPClassify] ${label} refresh rejected; keeping the ${slot.source} data: ${slot.lastError}`);
    } finally {
      slot.inflight = null;
      await publishStatus();
    }
  })();
}

function refreshTor(url: string | null): void {
  const slot = state.tor;
  refreshSlot(slot, url, 'Tor exit list', TOR_TTL_MS, async () => {
    const parsed = parseTorExitList((await download(url!, SMALL_DOWNLOAD_TIMEOUT_MS, TOR_MAX_BYTES)).toString('utf8'));
    const floor = minimumEntries(TOR_MIN_ENTRIES, slot.entries);
    if (parsed.size < floor) throw new Error(`only ${parsed.size} addresses (expected at least ${floor})`);
    return { value: parsed, entries: parsed.size, source: 'download', updatedAt: new Date() };
  });
}

function refreshHosting(url: string | null): void {
  const slot = state.hosting;
  refreshSlot(slot, url, 'Hosting ASN list', LIST_TTL_MS, async () => {
    const parsed = parseHostingAsnList((await download(url!, SMALL_DOWNLOAD_TIMEOUT_MS, HOSTING_MAX_BYTES)).toString('utf8'));
    const floor = minimumEntries(HOSTING_MIN_ENTRIES, SNAPSHOT_HOSTING.size);
    if (parsed.size < floor) throw new Error(`only ${parsed.size} ASNs (expected at least ${floor})`);
    // A download may add hosting ASNs but never remove a bundled one.
    const union = new Set<number>(SNAPSHOT_HOSTING);
    for (const asn of parsed) union.add(asn);
    return { value: union, entries: union.size, source: 'download', updatedAt: new Date() };
  });
}

/** Fails the stream once more than `limit` bytes pass through (a gzip bomb guard). */
function byteLimit(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) callback(new Error(`decompressed ASN database larger than ${limit} bytes`));
      else callback(null, chunk);
    },
  });
}

async function parseAsnBuffer(buffer: Buffer, minRanges: number): Promise<AsnTable> {
  const gzipped = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  const raw = Readable.from([buffer]);
  // pipeline() propagates an error from any stage (corrupt gzip, size limit)
  // to the readline consumer below instead of leaving it waiting forever.
  const input = gzipped
    ? pipeline(raw, createGunzip(), byteLimit(ASN_MAX_DECOMPRESSED_BYTES), () => undefined)
    : raw;
  const builder = new AsnTableBuilder();
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) builder.add(line);
  const table = builder.build();
  if (table.ranges < minRanges) {
    throw new Error(`only ${table.ranges} ASN ranges (expected at least ${minRanges})`);
  }
  return table;
}

function asnCacheName(url: string): string {
  return `asn-${createHash('sha256').update(url).digest('hex').slice(0, 16)}.db`;
}

async function readAsnCache(url: string): Promise<{ table: AsnTable; mtime: Date } | null> {
  const dir = await privateCacheDir();
  if (!dir) return null;
  const path = join(dir, asnCacheName(url));
  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    return null; // no cache yet
  }
  try {
    return { table: await parseAsnBuffer(await fs.readFile(path), ASN_MIN_RANGES), mtime: stat.mtime };
  } catch (error) {
    console.warn(`[IPClassify] ignoring an unreadable ASN database cache: ${errorText(error)}`);
    return null;
  }
}

async function writeAsnCache(url: string, body: Buffer): Promise<void> {
  try {
    const dir = await privateCacheDir();
    if (!dir) return;
    const path = join(dir, asnCacheName(url));
    const temp = `${path}.${process.pid}.tmp`;
    await fs.writeFile(temp, body, { mode: 0o600 });
    await fs.rename(temp, path);
  } catch (error) {
    console.warn(`[IPClassify] could not cache the ASN database on disk: ${errorText(error)}`);
  }
}

function refreshAsn(url: string | null): void {
  const slot = state.asn;
  refreshSlot(slot, url, 'ASN database', LIST_TTL_MS, async () => {
    // A process that has not loaded anything yet tries the disk cache first,
    // so a restart does not re-download the database. The cache file's mtime
    // is its age, so an old cache is not fresh.
    if (!slot.value) {
      const cached = await readAsnCache(url!);
      if (cached) {
        slot.value = cached.table;
        slot.source = 'disk';
        slot.entries = cached.table.ranges;
        slot.updatedAt = cached.mtime;
        slot.lastError = null;
        if (Date.now() - cached.mtime.getTime() < LIST_TTL_MS) {
          return { value: cached.table, entries: cached.table.ranges, source: 'disk', updatedAt: cached.mtime };
        }
      }
    }
    const body = await download(url!, ASN_DOWNLOAD_TIMEOUT_MS, ASN_MAX_BYTES);
    const table = await parseAsnBuffer(body, minimumEntries(ASN_MIN_RANGES, slot.entries));
    return { value: table, entries: table.ranges, source: 'download', updatedAt: new Date(), body };
  }, (body) => writeAsnCache(url!, body));
}

/**
 * Starts any due refresh and, when `waitMs` is set, waits up to that long for
 * in-flight loads to settle. Never throws.
 */
export async function ensureOfflineData(opts: { waitMs?: number } = {}): Promise<void> {
  if (!state.touched) {
    state.touched = true;
    void publishStatus();
  }
  refreshTor(ipClassifyTorListUrl());
  refreshHosting(ipClassifyHostingAsnUrl());
  refreshAsn(ipClassifyAsnDbUrl());

  const waitMs = opts.waitMs ?? 0;
  const pending = [state.tor.inflight, state.hosting.inflight, state.asn.inflight].filter(
    (p): p is Promise<void> => p !== null,
  );
  if (waitMs <= 0 || pending.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/** True when lookups can return the full ('offline') result: every source loaded and fresh. */
export function offlineBaselineComplete(): boolean {
  return dataIsCurrent();
}

/**
 * The newest accepted refresh of any source in this process, or null. A
 * stored "checked, nothing found" older than this was judged against data
 * that has since been replaced, so the promote job re-checks it.
 */
export function offlineDataRefreshedAt(): Date | null {
  let newest: Date | null = null;
  for (const slot of [state.tor, state.hosting, state.asn] as SourceState<unknown>[]) {
    if ((slot.source === 'download' || slot.source === 'disk') && slot.updatedAt) {
      if (!newest || slot.updatedAt > newest) newest = slot.updatedAt;
    }
  }
  return newest;
}

export async function offlineClassify(ip: string, opts: { waitMs?: number } = {}): Promise<IpClassification> {
  await ensureOfflineData(opts);
  return classifyWithOfflineData(ip, {
    tor: state.tor.value,
    hosting: state.hosting.value,
    asn: state.asn.value,
    current: dataIsCurrent(),
  });
}

function isStatus(value: unknown): value is OfflineClassifierStatus {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return ['tor', 'hosting', 'asn'].every((key) => {
    const s = rec[key] as Record<string, unknown> | undefined;
    return !!s && typeof s === 'object' && typeof s.source === 'string' && typeof s.entries === 'number';
  });
}

/**
 * What the offline classifier has loaded: this process's own view when it has
 * classified anything, otherwise the record the classifying process published
 * to Redis, otherwise null (nothing has classified since the status expired).
 */
export async function readOfflineClassifierStatus(): Promise<OfflineClassifierStatus | null> {
  if (state.touched) return localStatus();
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(OFFLINE_STATUS_REDIS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isStatus(parsed)) return null;
    return { ...parsed, current: parsed.current === true };
  } catch (error) {
    console.warn(`[IPClassify] could not read the offline classifier status: ${errorText(error)}`);
    return null;
  }
}

export function __resetOfflineDataForTests(): void {
  state = initialState();
}

export function __setOfflineCacheDirForTests(dir: string): void {
  cacheDir = dir;
}
