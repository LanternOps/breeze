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
 * while streaming (the socket is destroyed past PROMPT_LOGO_MAX_BYTES) and
 * times out. safeFetch also refuses to run inside a held DB transaction
 * (#1105): callers load logos only outside one.
 *
 * Caching: Redis `prompt-identity-logo:<sha256(source)>`, 3600 s for a
 * validated logo (bytes stored, re-checked against their sha on read) and
 * 600 s for a failure, so a broken URL is not refetched on every heartbeat.
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
export const PROMPT_LOGO_FETCH_TIMEOUT_MS = 5_000;

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

/**
 * The logo's format and size when `buf` is a PNG, JPEG or WebP within the
 * byte and pixel limits; otherwise null. Reads headers only and never decodes
 * pixels, so a well-formed header over a corrupt body still passes: the
 * renderer must treat a decode failure as "no logo".
 */
export function validatePromptLogo(buf: Uint8Array): PromptLogoInfo | null {
  if (buf.length === 0 || buf.length > PROMPT_LOGO_MAX_BYTES) return null;
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
    return null;
  }
  if (!dims) return null;
  const { width, height } = dims;
  if (!(width >= 1 && height >= 1 && width <= PROMPT_LOGO_MAX_SIDE && height <= PROMPT_LOGO_MAX_SIDE)) return null;
  return { mime, width, height };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

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

function decodeDataUrl(source: string): Uint8Array | null {
  if (source.length > MAX_DATA_URL_LENGTH) return null;
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

async function fetchHttpsLogo(source: string): Promise<Uint8Array | null> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const guard = checkSsrfSafe(url.href, { mode: 'strict-https' });
  if (!guard.ok) return null;
  const res = await safeFetch(url.href, {
    method: 'GET',
    headers: { accept: 'image/png, image/jpeg, image/webp' },
    timeoutMs: PROMPT_LOGO_FETCH_TIMEOUT_MS,
    maxBytes: PROMPT_LOGO_MAX_BYTES,
  });
  if (res.status !== 200) return null;
  return new Uint8Array(await res.arrayBuffer());
}

async function loadUncached(source: string): Promise<PromptLogo | null> {
  let bytes: Uint8Array | null = null;
  if (source.startsWith('data:')) {
    bytes = decodeDataUrl(source);
  } else if (source.startsWith('https://')) {
    try {
      bytes = await fetchHttpsLogo(source);
    } catch (err) {
      console.warn('[promptIdentityLogo] logo fetch failed; the prompt identity carries no logo:', err instanceof Error ? err.message : err);
      bytes = null;
    }
  }
  if (!bytes) return null;
  const info = validatePromptLogo(bytes);
  if (!info) return null;
  return { ...info, sha256: sha256Hex(bytes), bytes: bytes.length, data: bytes };
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
const memo = new Map<string, { at: number; logo: PromptLogo | null }>();
const inflight = new Map<string, Promise<PromptLogo | null>>();

function memoGet(sourceKey: string): PromptLogo | null | undefined {
  const hit = memo.get(sourceKey);
  if (!hit) return undefined;
  if (Date.now() - hit.at > MEMO_TTL_MS) {
    memo.delete(sourceKey);
    return undefined;
  }
  return hit.logo;
}

function memoSet(sourceKey: string, logo: PromptLogo | null): void {
  if (memo.size >= MEMO_MAX_ENTRIES && !memo.has(sourceKey)) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(sourceKey, { at: Date.now(), logo });
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

async function redisSet(sourceKey: string, logo: PromptLogo | null): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    const entry: CachedOk | CachedFail = logo
      ? { v: 1, ok: true, sha256: logo.sha256, mime: logo.mime, width: logo.width, height: logo.height, data: Buffer.from(logo.data).toString('base64') }
      : { v: 1, ok: false };
    await redis.set(
      cacheKeyFor(sourceKey),
      JSON.stringify(entry),
      'EX',
      logo ? PROMPT_LOGO_CACHE_TTL_SECONDS : PROMPT_LOGO_FAILURE_TTL_SECONDS,
    );
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

/**
 * The validated logo for `source`, or null (no source, unsupported format,
 * too large, refused URL, fetch failure). Never throws for a bad source.
 * Must be called outside a held DB transaction (it may fetch).
 */
export async function loadPromptIdentityLogo(source: string | null | undefined): Promise<PromptLogo | null> {
  if (typeof source !== 'string') return null;
  const trimmed = source.trim();
  if (!trimmed.startsWith('data:') && !trimmed.startsWith('https://')) return null;
  const sourceKey = promptLogoSourceKey(trimmed);
  const cached = await readCachedPromptLogo(sourceKey);
  if (cached !== undefined) return cached;

  const pending = inflight.get(sourceKey);
  if (pending) return pending;
  const work = (async () => {
    const logo = await loadUncached(trimmed);
    memoSet(sourceKey, logo);
    await redisSet(sourceKey, logo);
    return logo;
  })().finally(() => inflight.delete(sourceKey));
  inflight.set(sourceKey, work);
  return work;
}
