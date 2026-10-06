import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { PARTNER_API_CURSOR_SIGNING_KEY } from '../../config/env';
import { canonicalJsonStringify } from './exportSafety';
import { partnerExportCursorTokenSchema, partnerExportTimestampSchema } from './schemas';

/**
 * Signed tokens for the xid8-bounded Partner API change feeds
 * (GET /partner-api/alerts, GET /partner-api/tickets). One factory, one
 * HMAC domain per feed so a token minted for one feed can never be replayed
 * against another (nor against the timestamp-watermark export cursors in
 * cursor.ts).
 *
 * Kinds:
 *   - `page`: continues ONE traversal. Carries the traversal's fixed xid8
 *     window [lower, horizon) and the last (xid, id) returned.
 *   - `checkpoint`: returned on the last page. Its `horizon` is the next
 *     traversal's inclusive lower bound.
 *   - `keyset`: a plain (key, id) keyset page for a bounded sub-collection
 *     (a ticket's comments), bound to the partner and a scope hash.
 * Page/checkpoint tokens are bound to the partner, the exact filter set and
 * the exact org set they were minted for.
 */
export interface PartnerFeedTokenSpec {
  hmacDomain: string;
  tokenErrorCode: string;
  tokenErrorMessage: string;
  resyncCode: string;
  resyncMessage: string;
}

const PAGE_LIFETIME_MS = 24 * 60 * 60 * 1000;

const xid8String = z.string().regex(/^[0-9]{1,20}$/u);

const bindingSchema = z.object({
  partnerId: z.string().uuid(),
  // Database incarnation: cluster system identifier, timeline, database OID
  // and feed table OID. xid8 positions are meaningless across a restore, so
  // a token from another incarnation must force a resync rather than skip
  // restored rows. A restore into a new cluster changes the identifier;
  // point-in-time recovery changes the timeline; a logical restore into the
  // SAME cluster recreates the database or the table, which gets a new OID.
  // Not detectable here, and documented as needing a consumer-side full sync
  // (docs/integrations/partner-api.md): a filesystem/VM snapshot rollback of
  // the same cluster, and a data-only reload into the existing table with
  // triggers disabled.
  epoch: z.string().regex(/^[0-9]{1,20}:[0-9]{1,10}:[0-9]{1,10}:[0-9]{1,10}$/u),
  filtersHash: z.string().regex(/^[a-f0-9]{64}$/u),
  orgSetHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

const pageSchema = bindingSchema.extend({
  v: z.literal(1),
  kind: z.literal('page'),
  lower: xid8String.nullable(),
  horizon: xid8String,
  lastXid: xid8String,
  lastId: z.string().uuid(),
  expiresAt: partnerExportTimestampSchema,
}).strict();

const checkpointSchema = bindingSchema.extend({
  v: z.literal(1),
  kind: z.literal('checkpoint'),
  horizon: xid8String,
  issuedAt: partnerExportTimestampSchema,
}).strict();

const keysetBindingSchema = z.object({
  partnerId: z.string().uuid(),
  scopeHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

const keysetSchema = keysetBindingSchema.extend({
  v: z.literal(1),
  kind: z.literal('keyset'),
  // Opaque sort key as the database rendered it (a `timestamp::text` with
  // microseconds — an ISO string with milliseconds would collide with the
  // row it came from and repeat it on the next page).
  lastKey: z.string().min(1).max(64),
  lastId: z.string().uuid(),
  expiresAt: partnerExportTimestampSchema,
}).strict();

export type PartnerFeedBinding = z.infer<typeof bindingSchema>;
export type PartnerFeedPage = z.infer<typeof pageSchema>;
export type PartnerFeedCheckpoint = z.infer<typeof checkpointSchema>;
export type PartnerFeedKeysetBinding = z.infer<typeof keysetBindingSchema>;
export type PartnerFeedKeyset = z.infer<typeof keysetSchema>;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Order-insensitive hash of the org set a token is valid for. */
export function orgSetHash(orgIds: readonly string[]): string {
  return sha256Hex(canonicalJsonStringify([...new Set(orgIds)].sort()));
}

/** Compare two xid8 decimal strings without converting to Number. */
export function compareXid8(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

function assertKey(key: Buffer): void {
  if (key.length < 32) throw new Error('PARTNER_API_CURSOR_SIGNING_KEY must decode to at least 32 bytes.');
}

function sameBinding(token: PartnerFeedBinding, expected: PartnerFeedBinding): boolean {
  return token.partnerId === expected.partnerId
    && token.epoch === expected.epoch
    && token.filtersHash === expected.filtersHash
    && token.orgSetHash === expected.orgSetHash;
}

export function createPartnerFeedTokens(spec: PartnerFeedTokenSpec) {
  class TokenError extends Error {
    readonly status = 400;
    readonly code = spec.tokenErrorCode;
    constructor() {
      super(spec.tokenErrorMessage);
      this.name = 'PartnerFeedTokenError';
    }
  }

  /** The checkpoint no longer describes this principal's feed; start a full sync. */
  class ResyncRequiredError extends Error {
    readonly status = 409;
    readonly code = spec.resyncCode;
    constructor() {
      super(spec.resyncMessage);
      this.name = 'PartnerFeedResyncRequiredError';
    }
  }

  function sign(encodedPayload: string, key: Buffer): Buffer {
    return createHmac('sha256', key)
      .update(`${spec.hmacDomain}.${encodedPayload}`, 'utf8')
      .digest();
  }

  function encode(payload: unknown, key: Buffer): string {
    assertKey(key);
    const encodedPayload = Buffer.from(canonicalJsonStringify(payload), 'utf8').toString('base64url');
    const token = `${encodedPayload}.${sign(encodedPayload, key).toString('base64url')}`;
    if (!partnerExportCursorTokenSchema.safeParse(token).success) throw new TokenError();
    return token;
  }

  function decodeCanonical(segment: string): Buffer {
    if (!segment || !/^[A-Za-z0-9_-]+$/u.test(segment)) throw new TokenError();
    const decoded = Buffer.from(segment, 'base64url');
    if (decoded.toString('base64url') !== segment) throw new TokenError();
    return decoded;
  }

  function decode(token: string, key: Buffer): unknown {
    assertKey(key);
    try {
      if (!partnerExportCursorTokenSchema.safeParse(token).success) throw new TokenError();
      const parts = token.split('.');
      if (parts.length !== 2) throw new TokenError();
      const [encodedPayload, encodedSignature] = parts as [string, string];
      const payloadBytes = decodeCanonical(encodedPayload);
      const supplied = decodeCanonical(encodedSignature);
      const expected = sign(encodedPayload, key);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw new TokenError();
      }
      const raw = JSON.parse(payloadBytes.toString('utf8')) as unknown;
      if (Buffer.from(canonicalJsonStringify(raw), 'utf8').toString('base64url') !== encodedPayload) {
        throw new TokenError();
      }
      return raw;
    } catch (error) {
      if (error instanceof TokenError) throw error;
      throw new TokenError();
    }
  }

  function encodePageToken(
    page: Omit<PartnerFeedPage, 'v' | 'kind' | 'expiresAt'>,
    now = new Date(),
    key: Buffer = PARTNER_API_CURSOR_SIGNING_KEY,
  ): string {
    const payload = pageSchema.parse({
      ...page,
      v: 1,
      kind: 'page',
      expiresAt: new Date(now.getTime() + PAGE_LIFETIME_MS).toISOString(),
    });
    return encode(payload, key);
  }

  function decodePageToken(
    token: string,
    expected: PartnerFeedBinding,
    now = new Date(),
    key: Buffer = PARTNER_API_CURSOR_SIGNING_KEY,
  ): PartnerFeedPage {
    const parsed = pageSchema.safeParse(decode(token, key));
    if (!parsed.success) throw new TokenError();
    const page = parsed.data;
    if (page.partnerId === expected.partnerId && page.epoch !== expected.epoch) throw new ResyncRequiredError();
    if (!sameBinding(page, expected) || Date.parse(page.expiresAt) <= now.getTime()) {
      throw new TokenError();
    }
    if (compareXid8(page.lastXid, page.horizon) >= 0) throw new TokenError();
    if (page.lower !== null && compareXid8(page.lastXid, page.lower) < 0) throw new TokenError();
    return page;
  }

  function encodeCheckpointToken(
    checkpoint: Omit<PartnerFeedCheckpoint, 'v' | 'kind' | 'issuedAt'>,
    now = new Date(),
    key: Buffer = PARTNER_API_CURSOR_SIGNING_KEY,
  ): string {
    const payload = checkpointSchema.parse({ ...checkpoint, v: 1, kind: 'checkpoint', issuedAt: now.toISOString() });
    return encode(payload, key);
  }

  /**
   * Decode a `since` checkpoint. A checkpoint minted for a different partner
   * or filter set is simply invalid (400). One minted for a different ORG SET
   * is a resync (409): orgs that became accessible after it was issued hold
   * rows written before its horizon, which an incremental read would never
   * return.
   */
  function decodeCheckpointToken(
    token: string,
    expected: PartnerFeedBinding,
    key: Buffer = PARTNER_API_CURSOR_SIGNING_KEY,
  ): PartnerFeedCheckpoint {
    const parsed = checkpointSchema.safeParse(decode(token, key));
    if (!parsed.success) throw new TokenError();
    const checkpoint = parsed.data;
    if (checkpoint.partnerId !== expected.partnerId || checkpoint.filtersHash !== expected.filtersHash) {
      throw new TokenError();
    }
    if (checkpoint.orgSetHash !== expected.orgSetHash || checkpoint.epoch !== expected.epoch) {
      throw new ResyncRequiredError();
    }
    return checkpoint;
  }

  function encodeKeysetToken(
    keyset: Omit<PartnerFeedKeyset, 'v' | 'kind' | 'expiresAt'>,
    now = new Date(),
    key: Buffer = PARTNER_API_CURSOR_SIGNING_KEY,
  ): string {
    const payload = keysetSchema.parse({
      ...keyset,
      v: 1,
      kind: 'keyset',
      expiresAt: new Date(now.getTime() + PAGE_LIFETIME_MS).toISOString(),
    });
    return encode(payload, key);
  }

  function decodeKeysetToken(
    token: string,
    expected: PartnerFeedKeysetBinding,
    now = new Date(),
    key: Buffer = PARTNER_API_CURSOR_SIGNING_KEY,
  ): PartnerFeedKeyset {
    const parsed = keysetSchema.safeParse(decode(token, key));
    if (!parsed.success) throw new TokenError();
    const keyset = parsed.data;
    if (keyset.partnerId !== expected.partnerId || keyset.scopeHash !== expected.scopeHash) throw new TokenError();
    if (Date.parse(keyset.expiresAt) <= now.getTime()) throw new TokenError();
    return keyset;
  }

  return {
    TokenError,
    ResyncRequiredError,
    encodePageToken,
    decodePageToken,
    encodeCheckpointToken,
    decodeCheckpointToken,
    encodeKeysetToken,
    decodeKeysetToken,
  };
}

export type PartnerFeedTokens = ReturnType<typeof createPartnerFeedTokens>;
