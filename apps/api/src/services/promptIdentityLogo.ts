/**
 * The MSP logo drawn on every device prompt (#10190, spec §3.6, plan Task 3.2).
 *
 * A logo source is what Settings → Partner → Branding (or a portal_branding
 * org override) stores: a `data:` URL (uploads are re-encoded to one) or an
 * `https://` URL. It becomes a prompt logo only when its BYTES are a PNG, JPEG
 * or WebP by magic number, at most PROMPT_LOGO_MAX_BYTES, at most
 * PROMPT_LOGO_MAX_SIDE px per side. The mime comes from the bytes, never from
 * a `data:` header or a Content-Type. SVG (scriptable, and a renderer's parser
 * is attack surface on every endpoint) and every other format mean "no logo".
 *
 * The device never fetches a remote URL: the agent downloads the validated
 * bytes from the API over its authenticated channel
 * (routes/agents/promptIdentityLogo.ts) and checks the sha256.
 *
 * Fetching: an `https://` source is checked with checkSsrfSafe (strict-https:
 * no http, no IP literal in a private/loopback/metadata range, no loopback or
 * metadata hostname) and then fetched ONCE through safeFetch, which pins a
 * validated DNS answer for the socket (a hostname resolving into a blocked
 * range is refused at connect time), does not follow redirects, caps the body
 * while streaming (the socket is destroyed past PROMPT_LOGO_MAX_BYTES), and
 * bounds the wait for headers. On top of that, one overall deadline
 * (PROMPT_LOGO_DEADLINE_MS) aborts the request and settles the load whatever
 * the transport does: safeFetch's own `timeoutMs` is an inactivity timer that
 * a server trickling one byte at a time would keep resetting. safeFetch also
 * refuses to run inside a held DB transaction (#1105): callers load logos only
 * outside one. The heartbeat never waits on a fetch at all
 * (peekPromptIdentityLogo).
 *
 * Caching: Redis `prompt-identity-logo:<sha256(source)>`, 3600 s for a
 * validated logo (bytes stored, re-checked against their sha on read), 600 s
 * for a permanent failure and 60 s for a transient one, so a broken URL is not
 * refetched on every heartbeat.
 * A small in-process memo in front of Redis keeps a fleet of heartbeats from
 * pulling the same ~350 KB entry out of Redis on every device-cache miss.
 */
import { createHash } from 'node:crypto';
import { PROMPT_LOGO_MAX_BYTES, PROMPT_LOGO_MIMES } from '@breeze/shared/promptHost';
import { checkSsrfSafe } from './ssrfGuard';
import { getRedis } from './redis';
import { safeFetch } from './urlSafety';

export type PromptLogoMime = (typeof PROMPT_LOGO_MIMES)[number];

/** Largest width or height accepted, in pixels. */
export const PROMPT_LOGO_MAX_SIDE = 1024;

export const PROMPT_LOGO_CACHE_TTL_SECONDS = 3600;
export const PROMPT_LOGO_FAILURE_TTL_SECONDS = 600;
export const PROMPT_LOGO_TRANSIENT_FAILURE_TTL_SECONDS = 60;
/** safeFetch's headers timeout and socket-inactivity timeout. */
export const PROMPT_LOGO_FETCH_TIMEOUT_MS = 5_000;
/** The whole fetch, headers through last byte. */
export const PROMPT_LOGO_DEADLINE_MS = 8_000;

const MEMO_TTL_MS = 60_000;
const MEMO_MAX_ENTRIES = 64;

/** Longest `data:` URL worth decoding: base64 of the byte cap, plus a generous header. */
const MAX_DATA_URL_LENGTH = Math.ceil(PROMPT_LOGO_MAX_BYTES / 3) * 4 + 256;

export interface PromptLogoInfo {
  mime: PromptLogoMime;
  width: number;
  height: number;
}

export interface PromptLogo extends PromptLogoInfo {
  /** Lowercase hex sha256 of `data`. */
  sha256: string;
  /** Byte length of `data`. */
  bytes: number;
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// Header parsing (no image library: magic bytes and dimensions only)
// ---------------------------------------------------------------------------

function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}
function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
}
function u16le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}
function u24le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
}
function u32le(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}
function asciiAt(b: Uint8Array, o: number, s: string): boolean {
  if (b.length < o + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
  return true;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function parsePng(b: Uint8Array): { width: number; height: number } | null {
  // Signature, then the first chunk must be IHDR (length 13).
  if (b.length < 24 || !PNG_MAGIC.every((v, i) => b[i] === v)) return null;
  if (u32be(b, 8) !== 13 || !asciiAt(b, 12, 'IHDR')) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

/** SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC), which share the range. */
function isSofMarker(m: number): boolean {
  return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
}

function parseJpeg(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    let m = b[o + 1]!;
    // Fill bytes: any number of 0xFF before a marker.
    while (m === 0xff && o + 2 < b.length) {
      o += 1;
      m = b[o + 1]!;
    }
    o += 2;
    // Standalone markers carry no length.
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    // End of image or start of scan before any frame header: no dimensions.
    if (m === 0xd9 || m === 0xda) return null;
    if (o + 2 > b.length) return null;
    const len = u16be(b, o);
    if (len < 2) return null;
    if (isSofMarker(m)) {
      if (len < 7 || o + 7 > b.length) return null;
      return { height: u16be(b, o + 3), width: u16be(b, o + 5) };
    }
    o += len;
  }
  return null;
}

function parseWebp(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 20 || !asciiAt(b, 0, 'RIFF') || !asciiAt(b, 8, 'WEBP')) return null;
  const chunk = 12;
  const data = chunk + 8;
  if (asciiAt(b, chunk, 'VP8 ')) {
    // Frame tag (3 bytes), start code 9D 01 2A, then 14-bit width / height.
    if (b.length < data + 10 || b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) return null;
    return { width: u16le(b, data + 6) & 0x3fff, height: u16le(b, data + 8) & 0x3fff };
  }
  if (asciiAt(b, chunk, 'VP8L')) {
    // Signature 0x2F, then 14 bits (width - 1) and 14 bits (height - 1), LSB first.
    if (b.length < data + 5 || b[data] !== 0x2f) return null;
    const bits = u32le(b, data + 1);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (asciiAt(b, chunk, 'VP8X')) {
    // Flags (1), reserved (3), then 24-bit (canvas width - 1) and (height - 1).
    if (b.length < data + 10) return null;
    return { width: u24le(b, data + 4) + 1, height: u24le(b, data + 7) + 1 };
  }
  return null;
}

/** Why a buffer is not a prompt logo. */
type ImageRefusal = 'too_large' | 'invalid_image' | 'too_many_pixels';

function inspectPromptLogo(buf: Uint8Array): { ok: true; info: PromptLogoInfo } | { ok: false; reason: ImageRefusal } {
  if (buf.length === 0) return { ok: false, reason: 'invalid_image' };
  if (buf.length > PROMPT_LOGO_MAX_BYTES) return { ok: false, reason: 'too_large' };
  let mime: PromptLogoMime;
  let dims: { width: number; height: number } | null;
  if (buf[0] === 0x89) {
    mime = 'image/png';
    dims = parsePng(buf);
  } else if (buf[0] === 0xff) {
    mime = 'image/jpeg';
    dims = parseJpeg(buf);
  } else if (buf[0] === 0x52) {
    mime = 'image/webp';
    dims = parseWebp(buf);
  } else {
    return { ok: false, reason: 'invalid_image' };
  }
  if (!dims) return { ok: false, reason: 'invalid_image' };
  const { width, height } = dims;
  if (!(width >= 1 && height >= 1)) return { ok: false, reason: 'invalid_image' };
  if (width > PROMPT_LOGO_MAX_SIDE || height > PROMPT_LOGO_MAX_SIDE) return { ok: false, reason: 'too_many_pixels' };
  return { ok: true, info: { mime, width, height } };
}

/**
 * The logo's format and size when `buf` is a PNG, JPEG or WebP within the
 * byte and pixel limits; otherwise null. Reads headers only and never decodes
 * pixels, so a well-formed header over a corrupt body still passes: the
 * renderer must treat a decode failure as "no logo".
 */
export function validatePromptLogo(buf: Uint8Array): PromptLogoInfo | null {
  const r = inspectPromptLogo(buf);
  return r.ok ? r.info : null;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Why a source produced no logo. Logged (with the partner id, never the URL,
 * which can carry a signed token) once per load, not on cache hits.
 */
export type PromptLogoFailureReason =
  | 'unsupported_source'
  | 'invalid_data_url'
  | 'ssrf_refused'
  | 'http_status'
  | 'fetch_failed'
  | 'timeout'
  | ImageRefusal;

export interface PromptLogoLoadContext {
  /** For the operator log line only. */
  partnerId?: string | null;
}

type LoadOutcome =
  | { logo: PromptLogo }
  | { logo: null; reason: PromptLogoFailureReason; transient: boolean };

function sha256Hex(input: Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** The Redis key segment for a source: sha256 of the source string. */
export function promptLogoSourceKey(source: string): string {
  return sha256Hex(source);
}

export function promptLogoCacheKey(source: string): string {
  return cacheKeyFor(promptLogoSourceKey(source));
}

function cacheKeyFor(sourceKey: string): string {
  return `prompt-identity-logo:${sourceKey}`;
}

let deadlineOverrideMs: number | null = null;
/** Test seam: shorten the overall deadline (null restores the default). */
export function __setPromptLogoDeadlineForTests(ms: number | null): void {
  deadlineOverrideMs = ms;
}
function deadlineMs(): number {
  return deadlineOverrideMs ?? PROMPT_LOGO_DEADLINE_MS;
}

function percentDecode(s: string): Uint8Array | null {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x25) {
      const hex = s.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      out.push(parseInt(hex, 16));
      i += 2;
    } else if (c < 0x80) {
      out.push(c);
    } else {
      return null;
    }
  }
  return Uint8Array.from(out);
}

function decodeDataUrl(source: string): Uint8Array | 'too_large' | null {
  if (source.length > MAX_DATA_URL_LENGTH) return 'too_large';
  const comma = source.indexOf(',');
  if (comma < 0) return null;
  const meta = source.slice(5, comma).toLowerCase();
  const payload = source.slice(comma + 1);
  if (meta.split(';').includes('base64')) {
    const clean = payload.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
    return new Uint8Array(Buffer.from(clean, 'base64'));
  }
  return percentDecode(payload);
}

/** Synchronous refusals for an https source (no DNS, no socket). */
function precheckHttps(source: string): { url: URL } | { reason: 'unsupported_source' | 'ssrf_refused' } {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return { reason: 'unsupported_source' };
  }
  if (url.protocol !== 'https:') return { reason: 'unsupported_source' };
  if (url.username || url.password) return { reason: 'ssrf_refused' };
  if (!checkSsrfSafe(url.href, { mode: 'strict-https' }).ok) return { reason: 'ssrf_refused' };
  return { url };
}

function fromBytes(bytes: Uint8Array): LoadOutcome {
  const r = inspectPromptLogo(bytes);
  if (!r.ok) return { logo: null, reason: r.reason, transient: false };
  return { logo: { ...r.info, sha256: sha256Hex(bytes), bytes: bytes.length, data: bytes } };
}

async function fetchHttps(url: URL, signal: AbortSignal, onBody: (res: Response) => void): Promise<LoadOutcome> {
  let res: Response;
  try {
    res = await safeFetch(url.href, {
      method: 'GET',
      headers: { accept: 'image/png, image/jpeg, image/webp' },
      // timeoutMs is safeFetch's socket-INACTIVITY timer; a trickling server
      // resets it. headersTimeoutMs bounds the wait for the status line and
      // the signal bounds the whole request; the race in loadUncached is the
      // guarantee that the promise settles even if neither is honoured.
      timeoutMs: PROMPT_LOGO_FETCH_TIMEOUT_MS,
      headersTimeoutMs: PROMPT_LOGO_FETCH_TIMEOUT_MS,
      signal,
      maxBytes: PROMPT_LOGO_MAX_BYTES,
    });
  } catch {
    return { logo: null, reason: signal.aborted ? 'timeout' : 'fetch_failed', transient: true };
  }
  onBody(res);
  if (res.status !== 200) {
    return { logo: null, reason: 'http_status', transient: res.status >= 500 || res.status === 429 };
  }
  try {
    return fromBytes(new Uint8Array(await res.arrayBuffer()));
  } catch {
    // Size cap overrun, a reset mid-body, or the deadline's abort.
    return { logo: null, reason: signal.aborted ? 'timeout' : 'fetch_failed', transient: true };
  }
}

async function loadUncached(source: string): Promise<LoadOutcome> {
  if (source.startsWith('data:')) {
    const decoded = decodeDataUrl(source);
    if (decoded === 'too_large') return { logo: null, reason: 'too_large', transient: false };
    if (!decoded) return { logo: null, reason: 'invalid_data_url', transient: false };
    return fromBytes(decoded);
  }
  const pre = precheckHttps(source);
  if ('reason' in pre) return { logo: null, reason: pre.reason, transient: false };

  // One overall deadline for the whole fetch, headers through last byte. The
  // race guarantees the promise settles at the deadline whatever the
  // transport does, so a partner-chosen URL can never hold a caller (or the
  // fleet of callers joined on the same in-flight load).
  const controller = new AbortController();
  let body: Response | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<LoadOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      body?.body?.cancel().catch(() => {});
      resolve({ logo: null, reason: 'timeout', transient: true });
    }, deadlineMs());
  });
  try {
    return await Promise.race([fetchHttps(pre.url, controller.signal, (res) => { body = res; }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function logFailure(reason: PromptLogoFailureReason, ctx: PromptLogoLoadContext | undefined): void {
  console.warn('[promptIdentityLogo] prompt logo refused; the identity carries no logo', {
    partnerId: ctx?.partnerId ?? null,
    reason,
  });
}

interface CachedOk {
  v: 1;
  ok: true;
  sha256: string;
  mime: string;
  width: number;
  height: number;
  data: string;
}
interface CachedFail {
  v: 1;
  ok: false;
}

/** Re-validates a cached entry: bytes must still match their sha and pass the header check. */
function fromCached(raw: string): PromptLogo | null | undefined {
  let entry: CachedOk | CachedFail;
  try {
    entry = JSON.parse(raw) as CachedOk | CachedFail;
  } catch {
    return undefined;
  }
  if (!entry || entry.v !== 1) return undefined;
  if (entry.ok === false) return null;
  if (typeof entry.data !== 'string' || typeof entry.sha256 !== 'string') return undefined;
  const bytes = new Uint8Array(Buffer.from(entry.data, 'base64'));
  if (sha256Hex(bytes) !== entry.sha256) return undefined;
  const info = validatePromptLogo(bytes);
  if (!info) return undefined;
  return { ...info, sha256: entry.sha256, bytes: bytes.length, data: bytes };
}

// In-process memo: sourceKey -> result (null = known failure), short TTL.
const memo = new Map<string, { at: number; ttlMs: number; logo: PromptLogo | null }>();
const inflight = new Map<string, Promise<PromptLogo | null>>();

function memoGet(sourceKey: string): PromptLogo | null | undefined {
  const hit = memo.get(sourceKey);
  if (!hit) return undefined;
  if (Date.now() - hit.at > hit.ttlMs) {
    memo.delete(sourceKey);
    return undefined;
  }
  return hit.logo;
}

function memoSet(sourceKey: string, logo: PromptLogo | null, ttlMs = MEMO_TTL_MS): void {
  if (memo.size >= MEMO_MAX_ENTRIES && !memo.has(sourceKey)) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(sourceKey, { at: Date.now(), ttlMs, logo });
}

export function __resetPromptLogoMemoForTests(): void {
  memo.clear();
  inflight.clear();
}

async function redisGet(sourceKey: string): Promise<PromptLogo | null | undefined> {
  try {
    const redis = getRedis();
    if (!redis) return undefined;
    const raw = await redis.get(cacheKeyFor(sourceKey));
    return raw ? fromCached(raw) : undefined;
  } catch (err) {
    console.warn('[promptIdentityLogo] Redis read failed:', err);
    return undefined;
  }
}

async function redisSet(sourceKey: string, logo: PromptLogo | null, ttlSeconds: number): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    const entry: CachedOk | CachedFail = logo
      ? { v: 1, ok: true, sha256: logo.sha256, mime: logo.mime, width: logo.width, height: logo.height, data: Buffer.from(logo.data).toString('base64') }
      : { v: 1, ok: false };
    await redis.set(cacheKeyFor(sourceKey), JSON.stringify(entry), 'EX', ttlSeconds);
  } catch (err) {
    console.warn('[promptIdentityLogo] Redis write failed:', err);
  }
}

/**
 * A cached logo by source key (memo, then Redis), without ever fetching.
 * Undefined = not cached; null = cached failure.
 */
export async function readCachedPromptLogo(sourceKey: string): Promise<PromptLogo | null | undefined> {
  const memoHit = memoGet(sourceKey);
  if (memoHit !== undefined) return memoHit;
  const cached = await redisGet(sourceKey);
  if (cached !== undefined) memoSet(sourceKey, cached);
  return cached;
}

function isLoadableSource(source: unknown): source is string {
  return typeof source === 'string' && (source.trim().startsWith('data:') || source.trim().startsWith('https://'));
}

/**
 * The validated logo for `source`, or null (no source, unsupported format,
 * too large, refused URL, fetch failure, deadline). Never throws for a bad
 * source and always settles within the overall deadline. Must be called
 * outside a held DB transaction (it may fetch).
 *
 * Failure TTLs: a bad image, a refused URL or a 4xx is cached for
 * PROMPT_LOGO_FAILURE_TTL_SECONDS; a transient failure (thrown fetch,
 * deadline, 5xx, 429) only for PROMPT_LOGO_TRANSIENT_FAILURE_TTL_SECONDS, so a
 * blip costs a minute of logo, not ten. Either way a failure is cached, so a
 * fleet of heartbeats never hammers a broken URL.
 */
export async function loadPromptIdentityLogo(
  source: string | null | undefined,
  ctx?: PromptLogoLoadContext,
): Promise<PromptLogo | null> {
  if (typeof source !== 'string' || source.trim() === '') return null;
  if (!isLoadableSource(source)) {
    logFailure('unsupported_source', ctx);
    return null;
  }
  const trimmed = source.trim();
  const sourceKey = promptLogoSourceKey(trimmed);
  const cached = await readCachedPromptLogo(sourceKey);
  if (cached !== undefined) return cached;

  const pending = inflight.get(sourceKey);
  if (pending) return pending;
  const work = (async () => {
    const outcome = await loadUncached(trimmed);
    if (outcome.logo) {
      memoSet(sourceKey, outcome.logo);
      await redisSet(sourceKey, outcome.logo, PROMPT_LOGO_CACHE_TTL_SECONDS);
      return outcome.logo;
    }
    logFailure(outcome.reason, ctx);
    const ttl = outcome.transient ? PROMPT_LOGO_TRANSIENT_FAILURE_TTL_SECONDS : PROMPT_LOGO_FAILURE_TTL_SECONDS;
    memoSet(sourceKey, null, Math.min(MEMO_TTL_MS, ttl * 1000));
    await redisSet(sourceKey, null, ttl);
    return null;
  })().finally(() => inflight.delete(sourceKey));
  inflight.set(sourceKey, work);
  return work;
}

export type PromptLogoPeek =
  | { state: 'ready'; logo: PromptLogo }
  | { state: 'none' }
  | { state: 'pending' };

/**
 * The logo as the HEARTBEAT may use it: never waits on the network.
 * - `data:` sources and synchronously refused URLs are answered at once.
 * - An `https://` source already in the memo or Redis is answered from there.
 * - A cold `https://` source starts (or joins) one background load and
 *   answers `pending`; the caller omits the identity block this beat and the
 *   next beat finds the cached result.
 */
export async function peekPromptIdentityLogo(
  source: string | null | undefined,
  ctx?: PromptLogoLoadContext,
): Promise<PromptLogoPeek> {
  const asPeek = (logo: PromptLogo | null): PromptLogoPeek => (logo ? { state: 'ready', logo } : { state: 'none' });
  if (!isLoadableSource(source) || source.trim().startsWith('data:') || 'reason' in precheckHttps(source.trim())) {
    return asPeek(await loadPromptIdentityLogo(source, ctx));
  }
  const cached = await readCachedPromptLogo(promptLogoSourceKey(source.trim()));
  if (cached !== undefined) return asPeek(cached);
  void loadPromptIdentityLogo(source, ctx).catch((err) => {
    console.warn('[promptIdentityLogo] background logo load failed:', err instanceof Error ? err.name : 'error');
  });
  return { state: 'pending' };
}
