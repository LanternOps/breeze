import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { Resolver } from 'node:dns/promises';

// ARC verification for mail relayed through an inline gateway (#10862).
//
// Every ARC header is plain text a sender can write, so reading the text proves
// nothing: anyone can connect straight to a tenant's Exchange Online host with a
// hand-written `ARC-Authentication-Results: i=1; mx.gateway; dmarc=pass`. What a
// sender cannot produce is a signature for a `d=` domain they do not control, so
// the signatures are the proof and `d=` is the identity. The results' authserv-id
// is NOT: an attacker's own valid seal can name any authserv-id.
//
// At the highest instance k sealed by a trusted `d=`, two signatures are checked
// (RFC 8617):
//  - the ARC-Seal, over the ARC sets 1..k (section 4.1.3), which proves the
//    sealer wrote the results we read;
//  - the ARC-Message-Signature's header signature, which must cover From, so a
//    sealed set lifted from another message cannot be pasted onto a new From. Its
//    body hash is not checked: Graph does not return the body as the gateway saw
//    it, so a reused seal can still carry a different body.
// The instances under k are taken on the sealer's word (its cv=). The caller must
// still bind the sealed verdict to this message's From domain.
//
// DNS is only queried under a `d=` already on the operator's list. The sender
// picks only the selector label, which must match SELECTOR_RE.

export type ArcInvalidReason = 'chain' | 'stale' | 'key' | 'signature' | 'message-signature';

export type ArcEvaluation =
  | { status: 'verified'; sealer: string; instance: number; authResults: string }
  | { status: 'no-trusted-seal' }
  | { status: 'invalid'; sealer?: string; reason: ArcInvalidReason }
  /** `retryable`: this selector has returned a key before, so the failure is DNS
   * and not a selector the message made up. The sender picks the selector, so an
   * unknown one must never hold mail back for a retry. */
  | { status: 'dns-unavailable'; sealer: string; retryable: boolean };

export interface ArcDeps {
  resolveTxt(hostname: string): Promise<string[][]>;
}

type Header = { name: string; value: string };
type ArcSet = {
  results: Header;
  signature: Header;
  seal: Header;
  tags: Map<string, string>;
  signatureTags: Map<string, string>;
};

/** RFC 8617 limits a chain to 50 instances. */
const MAX_INSTANCE = 50;
/** A seal this far from the time Graph says the mail was received is not this
 * delivery. Bounds how long a lifted seal stays usable. */
const FRESHNESS_SECONDS = 6 * 60 * 60;
const MIN_RSA_BITS = 1024;
const DNS_TIMEOUT_MS = 3000;
const KEY_CACHE_TTL_MS = 60 * 60 * 1000;
/** A selector with no usable key: short, so a fix at the DNS side lands soon. */
const NO_KEY_CACHE_TTL_MS = 5 * 60 * 1000;
/** A failed lookup: one wait per sweep during an outage, not one per message. */
const DNS_FAILURE_CACHE_TTL_MS = 60 * 1000;
const KEY_CACHE_MAX = 256;
/** Resolver answers that mean "there is no such record", not "DNS is broken". */
const NO_RECORD_CODES = new Set(['ENOTFOUND', 'ENODATA']);

const SELECTOR_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/i;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
const defaultDeps: ArcDeps = { resolveTxt: (hostname) => resolver.resolveTxt(hostname) };

type CachedKey = { key: KeyObject | null | 'unavailable'; expiresAt: number };
const keyCache = new Map<string, CachedKey>();
/** Selectors that have returned a usable key in this process (bounded). */
const knownSelectors = new Set<string>();
const KNOWN_SELECTORS_MAX = 256;

/** Test-only seam. */
export function clearArcKeyCacheForTest(): void {
  keyCache.clear();
  knownSelectors.clear();
}

/** Tag list parser. A repeated tag is malformed (null): it could read one way here
 * and another way to a verifier that takes the first or last. */
function parseTags(value: string): Map<string, string> | null {
  const tags = new Map<string, string>();
  for (const part of value.split(';')) {
    if (!part.trim()) continue;
    const eq = part.indexOf('=');
    if (eq < 1) return null;
    const name = part.slice(0, eq).trim().toLowerCase();
    if (tags.has(name)) return null;
    tags.set(name, part.slice(eq + 1).replace(/\s+/g, ''));
  }
  return tags;
}

function instanceFrom(value: string, member: 'results' | 'signature' | 'seal'): number | null {
  // The results header must lead with i=; the signature and seal carry it as a tag.
  const match = member === 'results'
    ? /^\s*i\s*=\s*(\d{1,3})\s*(;|$)/.exec(value)
    : /(?:^|;)\s*i\s*=\s*(\d{1,3})\s*(;|$)/.exec(value);
  if (!match?.[1]) return null;
  const n = Number(match[1]);
  return n >= 1 && n <= MAX_INSTANCE ? n : null;
}

/**
 * Group the ARC headers into complete sets 1..n. 'none' when the message has no
 * ARC header at all; null when they do not form a chain (a gap, a duplicate, a
 * missing member, or a bad instance or tag list).
 */
function collectArcSets(headers: Header[]): ArcSet[] | null | 'none' {
  const byInstance = new Map<number, Partial<Pick<ArcSet, 'results' | 'signature' | 'seal'>>>();
  let seen = false;
  for (const h of headers) {
    const name = h.name.trim().toLowerCase();
    const member = name === 'arc-seal' ? 'seal'
      : name === 'arc-message-signature' ? 'signature'
        : name === 'arc-authentication-results' ? 'results'
          : null;
    if (!member) continue;
    seen = true;
    const instance = instanceFrom(h.value, member);
    if (instance === null) return null;
    const set = byInstance.get(instance) ?? {};
    if (set[member]) return null;
    set[member] = h;
    byInstance.set(instance, set);
  }
  if (!seen) return 'none';

  const sets: ArcSet[] = [];
  for (let i = 1; i <= byInstance.size; i++) {
    const set = byInstance.get(i);
    if (!set?.results || !set.signature || !set.seal) return null;
    const tags = parseTags(set.seal.value);
    const signatureTags = parseTags(set.signature.value);
    if (!tags || tags.get('i') !== String(i) || !signatureTags || signatureTags.get('i') !== String(i)) return null;
    sets.push({ results: set.results, signature: set.signature, seal: set.seal, tags, signatureTags });
  }
  return sets;
}

/** DKIM relaxed header canonicalization (RFC 6376 section 3.4.2), which is what
 * ARC requires. Also why a signature survives Graph unfolding a header's value. */
function canonicalize(name: string, value: string): string {
  return `${name.trim().toLowerCase()}:${value.replace(/\r?\n/g, '').replace(/[ \t]+/g, ' ').trim()}`;
}

/** Empty the header's own b= value, keeping every other tag byte for byte. */
function withEmptySignature(value: string): string {
  return value.replace(/(^|;)(\s*b\s*=)[^;]*/i, '$1$2');
}

/** RFC 8617 section 5.1.1: the ARC sets 1..k in order, the last seal's b= empty. */
function sealSignedData(sets: ArcSet[], k: number): string {
  const lines: string[] = [];
  for (let i = 0; i < k; i++) {
    const set = sets[i]!;
    lines.push(canonicalize(set.results.name, set.results.value));
    lines.push(canonicalize(set.signature.name, set.signature.value));
    lines.push(i === k - 1
      ? canonicalize(set.seal.name, withEmptySignature(set.seal.value))
      : canonicalize(set.seal.name, set.seal.value));
  }
  return lines.join('\r\n');
}

/**
 * RFC 6376 section 5.4.2: each name in h= takes the bottom-most instance not yet
 * used (a name with none left contributes nothing), then the signature header
 * itself with its b= empty. Graph lists headers top first.
 */
function messageSignatureSignedData(headers: Header[], signature: Header, signedNames: string[]): string {
  const remaining = new Map<string, Header[]>();
  for (const h of headers) {
    if (h === signature) continue;
    const name = h.name.trim().toLowerCase();
    const list = remaining.get(name) ?? [];
    list.push(h);
    remaining.set(name, list);
  }
  const lines: string[] = [];
  for (const name of signedNames) {
    const picked = remaining.get(name)?.pop();
    if (picked) lines.push(canonicalize(picked.name, picked.value));
  }
  lines.push(canonicalize(signature.name, withEmptySignature(signature.value)));
  return lines.join('\r\n');
}

/** Parse a DKIM key record. Null for anything unusable: revoked (empty p=), not
 * RSA, not base64 SPKI, or too short. */
function parseKeyRecord(record: string): KeyObject | null {
  const tags = parseTags(record);
  const p = tags?.get('p');
  if (!tags || !p) return null;
  const k = tags.get('k');
  if (k !== undefined && k.toLowerCase() !== 'rsa') return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(p)) return null;
  try {
    const key = createPublicKey({ key: Buffer.from(p, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'rsa') return null;
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) return null;
    return key;
  } catch {
    return null;
  }
}

/**
 * The selector's key, null when DNS answered with no usable key (including no
 * record at all), or 'unavailable' when DNS itself failed. Each outcome is cached
 * so a sweep does one lookup per selector, not one per message.
 */
async function lookupKey(hostname: string, deps: ArcDeps, now: number): Promise<KeyObject | null | 'unavailable'> {
  const cached = keyCache.get(hostname);
  if (cached && cached.expiresAt > now) return cached.key;
  let key: KeyObject | null | 'unavailable';
  let ttl: number;
  try {
    const records = await deps.resolveTxt(hostname);
    // More than one record at a selector is ambiguous, so it is not a usable key.
    key = records.length === 1 ? parseKeyRecord(records[0]!.join('')) : null;
    ttl = key ? KEY_CACHE_TTL_MS : NO_KEY_CACHE_TTL_MS;
    if (key && knownSelectors.size < KNOWN_SELECTORS_MAX) knownSelectors.add(hostname);
    if (!key) console.warn('[arcSeal] no usable key at selector', { hostname, records: records.length });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code && NO_RECORD_CODES.has(code)) {
      key = null;
      ttl = NO_KEY_CACHE_TTL_MS;
      console.warn('[arcSeal] no key record at selector', { hostname, code });
    } else {
      key = 'unavailable';
      ttl = DNS_FAILURE_CACHE_TTL_MS;
      console.warn('[arcSeal] key lookup failed', { hostname, code: code ?? 'unknown' });
    }
  }
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear();
  keyCache.set(hostname, { key, expiresAt: now + ttl });
  return key;
}

function verifies(data: string, key: KeyObject, signature: string): boolean {
  try {
    return verifySignature('sha256', Buffer.from(data), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** The sealed verdict without the leading `i=N;`, so it reads as Authentication-Results. */
function resultsWithoutInstance(value: string): string {
  return value.replace(/^\s*i\s*=\s*\d+\s*;\s*/, '').trim();
}

async function evaluate(
  headers: Header[],
  trustedSealers: readonly string[],
  receivedDateTime: string | undefined,
  deps: ArcDeps,
): Promise<ArcEvaluation> {
  const sets = collectArcSets(headers);
  if (sets === 'none') return { status: 'no-trusted-seal' };
  // A malformed chain names no sealer we could trust, so none is named here.
  if (sets === null) return { status: 'invalid', reason: 'chain' };

  // A cv=fail anywhere means a sealer saw a broken chain. A sender adding one can
  // only get their own mail quarantined.
  if (sets.some((set) => set.tags.get('cv')?.toLowerCase() === 'fail')) {
    return { status: 'invalid', reason: 'chain' };
  }

  let k = 0;
  for (let i = sets.length; i >= 1; i--) {
    if (trustedSealers.includes(sets[i - 1]!.tags.get('d')?.toLowerCase() ?? '')) {
      k = i;
      break;
    }
  }
  if (k === 0) return { status: 'no-trusted-seal' };

  const set = sets[k - 1]!;
  const sealer = set.tags.get('d')!.toLowerCase();
  const selector = set.tags.get('s');
  const sealSignature = set.tags.get('b');
  const expectedCv = k === 1 ? 'none' : 'pass';
  if (
    set.tags.get('a')?.toLowerCase() !== 'rsa-sha256'
    || set.tags.get('cv')?.toLowerCase() !== expectedCv
    || !selector || !SELECTOR_RE.test(selector)
    || !DOMAIN_RE.test(sealer)
    || !sealSignature
  ) {
    return { status: 'invalid', sealer, reason: 'chain' };
  }

  const sealedAt = Number(set.tags.get('t'));
  const receivedAt = receivedDateTime ? Date.parse(receivedDateTime) / 1000 : Number.NaN;
  if (
    !Number.isFinite(sealedAt) || !Number.isFinite(receivedAt)
    || Math.abs(receivedAt - sealedAt) > FRESHNESS_SECONDS
  ) {
    return { status: 'invalid', sealer, reason: 'stale' };
  }

  // The message signature at the same instance, by the same sealer, over From.
  const ams = set.signatureTags;
  const amsSelector = ams.get('s');
  const amsSignature = ams.get('b');
  const signedNames = (ams.get('h') ?? '').toLowerCase().split(':').filter(Boolean);
  const headerCanon = (ams.get('c') ?? 'simple/simple').toLowerCase().split('/')[0];
  if (
    ams.get('a')?.toLowerCase() !== 'rsa-sha256'
    || ams.get('d')?.toLowerCase() !== sealer
    || headerCanon !== 'relaxed'
    || !signedNames.includes('from')
    || !amsSelector || !SELECTOR_RE.test(amsSelector)
    || !amsSignature
  ) {
    return { status: 'invalid', sealer, reason: 'message-signature' };
  }

  const now = Date.now();
  const sealHost = `${selector.toLowerCase()}._domainkey.${sealer}`;
  const sealKey = await lookupKey(sealHost, deps, now);
  if (sealKey === 'unavailable') return { status: 'dns-unavailable', sealer, retryable: knownSelectors.has(sealHost) };
  if (!sealKey) return { status: 'invalid', sealer, reason: 'key' };
  if (!verifies(sealSignedData(sets, k), sealKey, sealSignature)) {
    return { status: 'invalid', sealer, reason: 'signature' };
  }

  const amsHost = `${amsSelector.toLowerCase()}._domainkey.${sealer}`;
  const amsKey = amsHost === sealHost ? sealKey : await lookupKey(amsHost, deps, now);
  if (amsKey === 'unavailable') return { status: 'dns-unavailable', sealer, retryable: knownSelectors.has(amsHost) };
  if (!amsKey) return { status: 'invalid', sealer, reason: 'key' };
  if (!verifies(messageSignatureSignedData(headers, set.signature, signedNames), amsKey, amsSignature)) {
    return { status: 'invalid', sealer, reason: 'message-signature' };
  }

  return { status: 'verified', sealer, instance: k, authResults: resultsWithoutInstance(set.results.value) };
}

/**
 * Check the message's ARC chain against the connection's trusted sealers. undefined
 * when none are configured: the connection has not opted in, and nothing is read.
 * Never throws: every failure is a result. Any result but 'verified' means the
 * seal supplies no verdict, and the caller falls back to Exchange's own stamp.
 */
export async function evaluateTrustedArc(
  headers: Header[] | undefined,
  trustedSealers: readonly string[],
  receivedDateTime: string | undefined,
  deps: ArcDeps = defaultDeps,
): Promise<ArcEvaluation | undefined> {
  if (trustedSealers.length === 0) return undefined;
  const usable = (headers ?? []).filter(
    (h): h is Header => typeof h?.name === 'string' && typeof h.value === 'string',
  );
  try {
    return await evaluate(usable, trustedSealers, receivedDateTime, deps);
  } catch (err) {
    console.error('[arcSeal] evaluation failed', { err: err instanceof Error ? err.message : String(err) });
    return { status: 'invalid', reason: 'chain' };
  }
}
