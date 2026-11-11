/**
 * Offline IP-classification baseline (#11698): loads and refreshes the three
 * datasets behind classifyWithOfflineData, used when no keyed provider is
 * configured.
 *
 *   - Tor exit list   — refreshed daily; bundled snapshot as the floor.
 *   - Hosting ASNs    — refreshed weekly; bundled snapshot as the floor.
 *   - ASN database    — refreshed weekly; NOT bundled (downloaded at runtime
 *                       and cached on local disk), so without a download the
 *                       classifier is Tor-only and says so ('offline-partial').
 *
 * Every download has a timeout, a size cap and a minimum-size sanity check; a
 * failure keeps whatever was loaded before and is retried at most hourly.
 * Nothing here runs at boot — the first classification triggers the loads, and
 * a lookup only waits for an in-flight load when its caller asks it to.
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
const RETRY_AFTER_FAILURE_MS = HOUR_MS;

const SMALL_DOWNLOAD_TIMEOUT_MS = 15_000;
const ASN_DOWNLOAD_TIMEOUT_MS = 120_000;
const TOR_MAX_BYTES = 4 * 1024 * 1024;
const HOSTING_MAX_BYTES = 2 * 1024 * 1024;
const ASN_MAX_BYTES = 64 * 1024 * 1024;
const ASN_MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;

/**
 * A download smaller than this is not the real list (a captive portal, an
 * error page, a truncated body) and is rejected rather than replacing good
 * data with an empty set.
 */
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
  reportedAt: string;
};

type SourceState<T> = {
  value: T;
  source: SourceKind;
  entries: number;
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

let cacheDir = join(tmpdir(), 'breeze-ip-classify');
let state = initialState();

function snapshotDate(value: string): Date | null {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function initialState(): State {
  const tor = parseTorExitList(TOR_EXIT_SNAPSHOT);
  const hosting = new Set(HOSTING_ASN_SNAPSHOT);
  return {
    tor: {
      value: tor, source: 'snapshot', entries: tor.size, updatedAt: snapshotDate(TOR_EXIT_SNAPSHOT_DATE),
      lastError: null, nextAttemptAt: 0, inflight: null,
    },
    hosting: {
      value: hosting, source: 'snapshot', entries: hosting.size, updatedAt: snapshotDate(HOSTING_ASN_SNAPSHOT_DATE),
      lastError: null, nextAttemptAt: 0, inflight: null,
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

async function download(url: string, timeoutMs: number, maxBytes: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'breeze-rmm-ip-classify' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`response larger than ${maxBytes} bytes`);
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > maxBytes) throw new Error(`response larger than ${maxBytes} bytes`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function publishStatus(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(OFFLINE_STATUS_REDIS_KEY, JSON.stringify(localStatus()), 'EX', STATUS_TTL_SECONDS);
  } catch {
    // Status display only; the classifier itself does not depend on Redis.
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
    reportedAt: new Date().toISOString(),
  };
}

function refreshList<T>(
  slot: SourceState<ReadonlySet<T>>,
  url: string | null,
  ttlMs: number,
  maxBytes: number,
  minEntries: number,
  parse: (text: string) => Set<T>,
  label: string,
): void {
  if (!url || slot.inflight || Date.now() < slot.nextAttemptAt) return;
  const current = slot;
  slot.inflight = (async () => {
    try {
      const parsed = parse((await download(url, SMALL_DOWNLOAD_TIMEOUT_MS, maxBytes)).toString('utf8'));
      if (parsed.size < minEntries) {
        throw new Error(`only ${parsed.size} entries (expected at least ${minEntries})`);
      }
      current.value = parsed;
      current.source = 'download';
      current.entries = parsed.size;
      current.updatedAt = new Date();
      current.lastError = null;
      current.nextAttemptAt = Date.now() + ttlMs;
    } catch (error) {
      current.lastError = errorText(error);
      current.nextAttemptAt = Date.now() + RETRY_AFTER_FAILURE_MS;
      console.warn(`[IPClassify] ${label} download failed; keeping the ${current.source} data: ${current.lastError}`);
    } finally {
      current.inflight = null;
      await publishStatus();
    }
  })();
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

async function parseAsnBuffer(buffer: Buffer): Promise<AsnTable> {
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
  if (table.ranges < ASN_MIN_RANGES) {
    throw new Error(`only ${table.ranges} ASN ranges (expected at least ${ASN_MIN_RANGES})`);
  }
  return table;
}

function asnCachePath(url: string): string {
  return join(cacheDir, `asn-${createHash('sha256').update(url).digest('hex').slice(0, 16)}.db`);
}

async function readAsnCache(url: string): Promise<{ table: AsnTable; mtime: Date } | null> {
  try {
    const path = asnCachePath(url);
    const stat = await fs.stat(path);
    return { table: await parseAsnBuffer(await fs.readFile(path)), mtime: stat.mtime };
  } catch {
    return null;
  }
}

async function writeAsnCache(url: string, body: Buffer): Promise<void> {
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    const path = asnCachePath(url);
    const temp = `${path}.${process.pid}.tmp`;
    await fs.writeFile(temp, body);
    await fs.rename(temp, path);
  } catch (error) {
    console.warn(`[IPClassify] could not cache the ASN database on disk: ${errorText(error)}`);
  }
}

function refreshAsn(url: string | null): void {
  const slot = state.asn;
  if (!url || slot.inflight || Date.now() < slot.nextAttemptAt) return;
  slot.inflight = (async () => {
    try {
      // A process that has not loaded anything yet tries the disk cache first,
      // so a restart does not re-download the database.
      if (!slot.value) {
        const cached = await readAsnCache(url);
        if (cached) {
          slot.value = cached.table;
          slot.source = 'disk';
          slot.entries = cached.table.ranges;
          slot.updatedAt = cached.mtime;
          slot.lastError = null;
          if (Date.now() - cached.mtime.getTime() < LIST_TTL_MS) {
            slot.nextAttemptAt = cached.mtime.getTime() + LIST_TTL_MS;
            return;
          }
        }
      }
      const body = await download(url, ASN_DOWNLOAD_TIMEOUT_MS, ASN_MAX_BYTES);
      const table = await parseAsnBuffer(body);
      slot.value = table;
      slot.source = 'download';
      slot.entries = table.ranges;
      slot.updatedAt = new Date();
      slot.lastError = null;
      slot.nextAttemptAt = Date.now() + LIST_TTL_MS;
      await writeAsnCache(url, body);
    } catch (error) {
      slot.lastError = errorText(error);
      slot.nextAttemptAt = Date.now() + RETRY_AFTER_FAILURE_MS;
      console.warn(
        `[IPClassify] ASN database download failed; ${slot.value ? `keeping the ${slot.source} copy` : 'classifying Tor-only'}: ${slot.lastError}`,
      );
    } finally {
      slot.inflight = null;
      await publishStatus();
    }
  })();
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
  refreshList(state.tor, ipClassifyTorListUrl(), TOR_TTL_MS, TOR_MAX_BYTES, TOR_MIN_ENTRIES, parseTorExitList, 'Tor exit list');
  refreshList(
    state.hosting, ipClassifyHostingAsnUrl(), LIST_TTL_MS, HOSTING_MAX_BYTES, HOSTING_MIN_ENTRIES,
    parseHostingAsnList, 'Hosting ASN list',
  );
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

/** True once an ASN database is loaded, i.e. the full baseline can run. */
export function offlineBaselineComplete(): boolean {
  return state.asn.value !== null && state.hosting.value.size > 0;
}

export async function offlineClassify(ip: string, opts: { waitMs?: number } = {}): Promise<IpClassification> {
  await ensureOfflineData(opts);
  return classifyWithOfflineData(ip, {
    tor: state.tor.value,
    hosting: state.hosting.value,
    asn: state.asn.value,
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
    return isStatus(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function __resetOfflineDataForTests(): void {
  state = initialState();
}

export function __setOfflineCacheDirForTests(dir: string): void {
  cacheDir = dir;
}
