import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { Resolver } from 'node:dns/promises';

// ARC-Seal verification for mail relayed through an inline gateway (#10862).
//
// Every ARC header is plain text a sender can write, so reading the text proves
// nothing: anyone can connect straight to a tenant's Exchange Online host with a
// hand-written `ARC-Authentication-Results: i=1; mx.gateway; dmarc=pass`. What a
// sender cannot produce is the seal's RSA signature for a `d=` domain they do not
// control, so the signature is the proof and `d=` is the identity. The results'
// authserv-id is NOT: an attacker's own valid seal can name any authserv-id.
//
// RFC 8617 section 4.1.3: the seal at instance k signs the ARC sets 1..k (relaxed
// canonicalization, rsa-sha256) and only those, not the message. Only instance k's
// seal is checked, on the sealer's word (its cv=) for the instances under it. The
// caller must still bind the sealed verdict to this message's From domain.
//
// DNS is only ever queried for a `d=` already on the operator's list, so message
// content cannot make this worker look up a name of the sender's choosing.

export type ArcInvalidReason = 'chain' | 'stale' | 'key' | 'signature';

export type ArcEvaluation =
  | { status: 'verified'; sealer: string; instance: number; authResults: string }
  | { status: 'no-trusted-seal' }
  | { status: 'invalid'; sealer?: string; reason: ArcInvalidReason }
  | { status: 'dns-unavailable'; sealer: string };

export interface ArcDeps {
  resolveTxt(hostname: string): Promise<string[][]>;
}

type Header = { name: string; value: string };
type ArcSet = { results: Header; signature: Header; seal: Header; tags: Map<string, string> };

/** RFC 8617 section 4.2.1: a chain longer than this is not valid. */
const MAX_INSTANCE = 50;
/** A seal this far from Exchange's receipt time is not this delivery. Bounds replay. */
const FRESHNESS_SECONDS = 6 * 60 * 60;
const MIN_RSA_BITS = 1024;
const DNS_TIMEOUT_MS = 3000;
const KEY_CACHE_TTL_MS = 60 * 60 * 1000;
const KEY_CACHE_MAX = 64;

const SELECTOR_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/i;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
const defaultDeps: ArcDeps = { resolveTxt: (hostname) => resolver.resolveTxt(hostname) };

type CachedKey = { key: KeyObject | null; expiresAt: number };
const keyCache = new Map<string, CachedKey>();

/** Test-only seam. */
export function clearArcKeyCacheForTest(): void {
  keyCache.clear();
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

function instanceFrom(value: string): number | null {
  const match = /^\s*i\s*=\s*(\d{1,3})\s*(;|$)/.exec(value)
    ?? /;\s*i\s*=\s*(\d{1,3})\s*(;|$)/.exec(value);
  if (!match?.[1]) return null;
  const n = Number(match[1]);
  return n >= 1 && n <= MAX_INSTANCE ? n : null;
}

/** Group the ARC headers into complete sets 1..n, or null if they do not form one
 * (a gap, a duplicate, a missing member, or a bad instance tag). */
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
    const instance = instanceFrom(h.value);
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
    if (!tags || tags.get('i') !== String(i)) return null;
    sets.push({ results: set.results, signature: set.signature, seal: set.seal, tags });
  }
  return sets;
}

/** DKIM relaxed header canonicalization (RFC 6376 section 3.4.2), which is what
 * ARC requires. Also why the seal survives Graph unfolding a header's value. */
function canonicalize(name: string, value: string): string {
  return `${name.trim().toLowerCase()}:${value.replace(/\r?\n/g, '').replace(/[ \t]+/g, ' ').trim()}`;
}

/** Empty the seal's own b= value, keeping every other tag byte for byte. */
function withEmptySignature(value: string): string {
  return value.replace(/(^|;)(\s*b\s*=)[^;]*/i, '$1$2');
}

function signedData(sets: ArcSet[], k: number): string {
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

/** Throws when DNS itself failed; returns null when it answered with no usable key. */
async function lookupKey(hostname: string, deps: ArcDeps, now: number): Promise<KeyObject | null> {
  const cached = keyCache.get(hostname);
  if (cached && cached.expiresAt > now) return cached.key;
  const records = await deps.resolveTxt(hostname);
  // More than one record at a selector is ambiguous, so it is not a usable key.
  const key = records.length === 1 ? parseKeyRecord(records[0]!.join('')) : null;
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear();
  keyCache.set(hostname, { key, expiresAt: now + KEY_CACHE_TTL_MS });
  return key;
}

/** The sealed verdict without the leading `i=N;`, so it reads as Authentication-Results. */
function resultsWithoutInstance(value: string): string {
  return value.replace(/^\s*i\s*=\s*\d+\s*;\s*/, '').trim();
}

/**
 * Check the message's ARC chain against the connection's trusted sealers. undefined
 * when none are configured: the connection has not opted in, and nothing is read.
 * Never throws: every failure is a result, and every result but 'verified' leaves
 * the mail unverified.
 */
export async function evaluateTrustedArc(
  headers: Header[] | undefined,
  trustedSealers: readonly string[],
  receivedDateTime: string | undefined,
  deps: ArcDeps = defaultDeps,
): Promise<ArcEvaluation | undefined> {
  if (trustedSealers.length === 0) return undefined;

  const sets = collectArcSets(headers ?? []);
  if (sets === 'none') return { status: 'no-trusted-seal' };
  if (sets === null) {
    // Only name a failure if a trusted sealer is involved; a malformed chain from
    // anyone else is simply not a trusted seal, but it must still not pass.
    return { status: 'invalid', reason: 'chain' };
  }

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
  const signature = set.tags.get('b');
  const expectedCv = k === 1 ? 'none' : 'pass';
  if (
    set.tags.get('a')?.toLowerCase() !== 'rsa-sha256'
    || set.tags.get('cv')?.toLowerCase() !== expectedCv
    || !selector || !SELECTOR_RE.test(selector)
    || !DOMAIN_RE.test(sealer)
    || !signature
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

  let key: KeyObject | null;
  try {
    key = await lookupKey(`${selector.toLowerCase()}._domainkey.${sealer}`, deps, Date.now());
  } catch {
    return { status: 'dns-unavailable', sealer };
  }
  if (!key) return { status: 'invalid', sealer, reason: 'key' };

  let valid = false;
  try {
    valid = verifySignature('sha256', Buffer.from(signedData(sets, k)), key, Buffer.from(signature, 'base64'));
  } catch {
    valid = false;
  }
  if (!valid) return { status: 'invalid', sealer, reason: 'signature' };

  return { status: 'verified', sealer, instance: k, authResults: resultsWithoutInstance(set.results.value) };
}
