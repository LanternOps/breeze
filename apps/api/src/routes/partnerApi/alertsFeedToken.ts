import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { PARTNER_API_CURSOR_SIGNING_KEY } from '../../config/env';
import { canonicalJsonStringify } from './exportSafety';
import { partnerExportCursorTokenSchema, partnerExportTimestampSchema } from './schemas';

/**
 * Signed tokens for the partner alerts feed (GET /partner-api/alerts).
 *
 * Two kinds, one HMAC domain distinct from the timestamp-watermark export
 * cursors (cursor.ts) so neither can be replayed as the other:
 *   - `page`: continues ONE traversal. Carries the traversal's fixed xid8
 *     window [lower, horizon) and the last (xid, id) returned.
 *   - `checkpoint`: returned on the last page. Its `horizon` is the next
 *     traversal's inclusive lower bound.
 * Both are bound to the partner, the exact filter set and the exact org set
 * they were minted for.
 */
export const PARTNER_ALERTS_FEED_HMAC_DOMAIN = 'breeze-partner-alerts-feed-v1';
const PAGE_LIFETIME_MS = 24 * 60 * 60 * 1000;

const xid8String = z.string().regex(/^[0-9]{1,20}$/u);

const bindingSchema = z.object({
  partnerId: z.string().uuid(),
  // Database incarnation: cluster system identifier + timeline. xid8 positions
  // are meaningless across a restore (dump/restore gets a new identifier;
  // point-in-time recovery gets a new timeline), so a token from another
  // incarnation must force a resync rather than skip restored rows.
  epoch: z.string().regex(/^[0-9]{1,20}:[0-9]{1,10}$/u),
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

export type PartnerAlertsFeedBinding = z.infer<typeof bindingSchema>;
export type PartnerAlertsFeedPage = z.infer<typeof pageSchema>;
export type PartnerAlertsFeedCheckpoint = z.infer<typeof checkpointSchema>;

export class PartnerAlertsFeedTokenError extends Error {
  readonly status = 400;
  readonly code = 'invalid_partner_alerts_token';
  constructor() {
    super('The partner alerts cursor or checkpoint is invalid or expired.');
    this.name = 'PartnerAlertsFeedTokenError';
  }
}

/** The checkpoint no longer describes this principal's feed; start a full sync. */
export class PartnerAlertsResyncRequiredError extends Error {
  readonly status = 409;
  readonly code = 'partner_alerts_resync_required';
  constructor() {
    super('The alerts checkpoint no longer matches this feed. Start a full sync without `since`.');
    this.name = 'PartnerAlertsResyncRequiredError';
  }
}

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

function sign(encodedPayload: string, key: Buffer): Buffer {
  return createHmac('sha256', key)
    .update(`${PARTNER_ALERTS_FEED_HMAC_DOMAIN}.${encodedPayload}`, 'utf8')
    .digest();
}

function assertKey(key: Buffer): void {
  if (key.length < 32) throw new Error('PARTNER_API_CURSOR_SIGNING_KEY must decode to at least 32 bytes.');
}

function encode(payload: unknown, key: Buffer): string {
  assertKey(key);
  const encodedPayload = Buffer.from(canonicalJsonStringify(payload), 'utf8').toString('base64url');
  const token = `${encodedPayload}.${sign(encodedPayload, key).toString('base64url')}`;
  if (!partnerExportCursorTokenSchema.safeParse(token).success) throw new PartnerAlertsFeedTokenError();
  return token;
}

function decodeCanonical(segment: string): Buffer {
  if (!segment || !/^[A-Za-z0-9_-]+$/u.test(segment)) throw new PartnerAlertsFeedTokenError();
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.toString('base64url') !== segment) throw new PartnerAlertsFeedTokenError();
  return decoded;
}

function decode(token: string, key: Buffer): unknown {
  assertKey(key);
  try {
    if (!partnerExportCursorTokenSchema.safeParse(token).success) throw new PartnerAlertsFeedTokenError();
    const parts = token.split('.');
    if (parts.length !== 2) throw new PartnerAlertsFeedTokenError();
    const [encodedPayload, encodedSignature] = parts as [string, string];
    const payloadBytes = decodeCanonical(encodedPayload);
    const supplied = decodeCanonical(encodedSignature);
    const expected = sign(encodedPayload, key);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new PartnerAlertsFeedTokenError();
    }
    const raw = JSON.parse(payloadBytes.toString('utf8')) as unknown;
    if (Buffer.from(canonicalJsonStringify(raw), 'utf8').toString('base64url') !== encodedPayload) {
      throw new PartnerAlertsFeedTokenError();
    }
    return raw;
  } catch (error) {
    if (error instanceof PartnerAlertsFeedTokenError) throw error;
    throw new PartnerAlertsFeedTokenError();
  }
}

function sameBinding(token: PartnerAlertsFeedBinding, expected: PartnerAlertsFeedBinding): boolean {
  return token.partnerId === expected.partnerId
    && token.epoch === expected.epoch
    && token.filtersHash === expected.filtersHash
    && token.orgSetHash === expected.orgSetHash;
}

export function encodePageToken(
  page: Omit<PartnerAlertsFeedPage, 'v' | 'kind' | 'expiresAt'>,
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

export function decodePageToken(
  token: string,
  expected: PartnerAlertsFeedBinding,
  now = new Date(),
  key: Buffer = PARTNER_API_CURSOR_SIGNING_KEY,
): PartnerAlertsFeedPage {
  const parsed = pageSchema.safeParse(decode(token, key));
  if (!parsed.success) throw new PartnerAlertsFeedTokenError();
  const page = parsed.data;
  if (page.partnerId === expected.partnerId && page.epoch !== expected.epoch) throw new PartnerAlertsResyncRequiredError();
  if (!sameBinding(page, expected) || Date.parse(page.expiresAt) <= now.getTime()) {
    throw new PartnerAlertsFeedTokenError();
  }
  if (compareXid8(page.lastXid, page.horizon) >= 0) throw new PartnerAlertsFeedTokenError();
  if (page.lower !== null && compareXid8(page.lastXid, page.lower) < 0) throw new PartnerAlertsFeedTokenError();
  return page;
}

export function encodeCheckpointToken(
  checkpoint: Omit<PartnerAlertsFeedCheckpoint, 'v' | 'kind' | 'issuedAt'>,
  now = new Date(),
  key: Buffer = PARTNER_API_CURSOR_SIGNING_KEY,
): string {
  const payload = checkpointSchema.parse({ ...checkpoint, v: 1, kind: 'checkpoint', issuedAt: now.toISOString() });
  return encode(payload, key);
}

/**
 * Decode a `since` checkpoint. A checkpoint minted for a different partner or
 * filter set is simply invalid (400). One minted for a different ORG SET is a
 * resync (409): orgs that became accessible after it was issued hold alerts
 * written before its horizon, which an incremental read would never return.
 */
export function decodeCheckpointToken(
  token: string,
  expected: PartnerAlertsFeedBinding,
  key: Buffer = PARTNER_API_CURSOR_SIGNING_KEY,
): PartnerAlertsFeedCheckpoint {
  const parsed = checkpointSchema.safeParse(decode(token, key));
  if (!parsed.success) throw new PartnerAlertsFeedTokenError();
  const checkpoint = parsed.data;
  if (checkpoint.partnerId !== expected.partnerId || checkpoint.filtersHash !== expected.filtersHash) {
    throw new PartnerAlertsFeedTokenError();
  }
  if (checkpoint.orgSetHash !== expected.orgSetHash || checkpoint.epoch !== expected.epoch) {
    throw new PartnerAlertsResyncRequiredError();
  }
  return checkpoint;
}
