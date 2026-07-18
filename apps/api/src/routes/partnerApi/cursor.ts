import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { PARTNER_API_CURSOR_SIGNING_KEY } from '../../config/env';
import { canonicalJsonStringify } from './exportSafety';
import {
  PARTNER_EXPORT_CURSOR_MAX_LENGTH,
  partnerExportCursorTokenSchema,
  partnerExportResourceSchema,
  partnerExportTimestampSchema,
  type PartnerExportResource,
} from './schemas';
import { normalizePartnerExportTimestamp } from './pagination';

export { PARTNER_EXPORT_CURSOR_MAX_LENGTH } from './schemas';

export const PARTNER_EXPORT_CURSOR_HMAC_DOMAIN = 'breeze-partner-export-cursor-v1';
const CURSOR_ERROR_MESSAGE = 'The partner export cursor is invalid or expired.';

export interface PartnerExportCursor {
  v: 1;
  resource: PartnerExportResource;
  partnerId: string;
  snapshotAt: string;
  updatedSince: string | null;
  filters: PartnerExportCursorFilters;
  lastUpdatedAt: string | null;
  lastId: string;
  lastOrgId: string | null;
  expiresAt: string;
}

export interface PartnerExportCursorFilters {
  orgId: string | null;
  siteId: string | null;
}

const partnerExportCursorFiltersSchema = z.object({
  orgId: z.string().uuid().nullable(),
  siteId: z.string().uuid().nullable(),
}).strict();

const partnerExportCursorSchema = z.object({
  v: z.literal(1),
  resource: partnerExportResourceSchema,
  partnerId: z.string().uuid(),
  snapshotAt: partnerExportTimestampSchema,
  updatedSince: partnerExportTimestampSchema.nullable(),
  filters: partnerExportCursorFiltersSchema,
  lastUpdatedAt: partnerExportTimestampSchema.nullable(),
  lastId: z.string().uuid(),
  lastOrgId: z.string().uuid().nullable(),
  expiresAt: partnerExportTimestampSchema,
}).strict().superRefine((value, ctx) => {
  if ((value.updatedSince === null) !== (value.lastUpdatedAt === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lastUpdatedAt'],
      message: 'lastUpdatedAt must be present only for incremental cursors',
    });
  }
  const snapshot = Date.parse(value.snapshotAt);
  const expiry = Date.parse(value.expiresAt);
  if (expiry <= snapshot) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'cursor expiry must follow its snapshot' });
  }
  if (value.updatedSince !== null && Date.parse(value.updatedSince) >= snapshot) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['updatedSince'], message: 'updatedSince must precede the snapshot' });
  }
  if (value.lastUpdatedAt !== null) {
    const lastUpdated = Date.parse(value.lastUpdatedAt);
    if (lastUpdated <= Date.parse(value.updatedSince!) || lastUpdated > snapshot) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lastUpdatedAt'], message: 'lastUpdatedAt is outside the traversal window' });
    }
  }
});

export class PartnerExportCursorError extends Error {
  readonly status = 400;
  readonly code = 'invalid_partner_export_cursor';

  constructor() {
    super(CURSOR_ERROR_MESSAGE);
    this.name = 'PartnerExportCursorError';
  }
}

function assertSigningKey(key: Buffer): void {
  if (key.length < 32) throw new Error('PARTNER_API_CURSOR_SIGNING_KEY must decode to at least 32 bytes.');
}

function signPayload(encodedPayload: string, key: Buffer): Buffer {
  return createHmac('sha256', key)
    .update(`${PARTNER_EXPORT_CURSOR_HMAC_DOMAIN}.${encodedPayload}`, 'utf8')
    .digest();
}

function normalizeCursor(cursor: PartnerExportCursor): PartnerExportCursor {
  return {
    ...cursor,
    snapshotAt: normalizePartnerExportTimestamp(cursor.snapshotAt, 'cursor snapshotAt'),
    updatedSince: cursor.updatedSince === null
      ? null
      : normalizePartnerExportTimestamp(cursor.updatedSince, 'cursor updatedSince'),
    lastUpdatedAt: cursor.lastUpdatedAt === null
      ? null
      : normalizePartnerExportTimestamp(cursor.lastUpdatedAt, 'cursor lastUpdatedAt'),
    expiresAt: normalizePartnerExportTimestamp(cursor.expiresAt, 'cursor expiresAt'),
  };
}

function decodeCanonicalBase64Url(segment: string): Buffer {
  if (!segment || !/^[A-Za-z0-9_-]+$/u.test(segment)) throw new PartnerExportCursorError();
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.toString('base64url') !== segment) throw new PartnerExportCursorError();
  return decoded;
}

export function encodePartnerExportCursor(
  cursor: PartnerExportCursor,
  signingKey: Buffer = PARTNER_API_CURSOR_SIGNING_KEY,
): string {
  assertSigningKey(signingKey);
  const parsed = partnerExportCursorSchema.safeParse(cursor);
  if (!parsed.success) throw new PartnerExportCursorError();
  const encodedPayload = Buffer.from(canonicalJsonStringify(normalizeCursor(parsed.data)), 'utf8').toString('base64url');
  const token = `${encodedPayload}.${signPayload(encodedPayload, signingKey).toString('base64url')}`;
  if (!partnerExportCursorTokenSchema.safeParse(token).success) throw new PartnerExportCursorError();
  return token;
}

export interface PartnerExportCursorBinding {
  partnerId: string;
  resource: PartnerExportResource;
  updatedSince: string | null;
  filters: PartnerExportCursorFilters;
}

export function decodePartnerExportCursor(
  token: string,
  expected: PartnerExportCursorBinding,
  signingKey: Buffer = PARTNER_API_CURSOR_SIGNING_KEY,
  now = new Date(),
): PartnerExportCursor {
  assertSigningKey(signingKey);
  try {
    if (!partnerExportCursorTokenSchema.safeParse(token).success) throw new PartnerExportCursorError();
    const parts = token.split('.');
    if (parts.length !== 2) throw new PartnerExportCursorError();
    const [encodedPayload, encodedSignature] = parts as [string, string];
    const payloadBytes = decodeCanonicalBase64Url(encodedPayload);
    const suppliedSignature = decodeCanonicalBase64Url(encodedSignature);
    const expectedSignature = signPayload(encodedPayload, signingKey);
    if (
      suppliedSignature.length !== expectedSignature.length
      || !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      throw new PartnerExportCursorError();
    }

    const raw = JSON.parse(payloadBytes.toString('utf8')) as unknown;
    const canonicalPayload = Buffer.from(canonicalJsonStringify(raw), 'utf8').toString('base64url');
    if (canonicalPayload !== encodedPayload) throw new PartnerExportCursorError();
    const parsed = partnerExportCursorSchema.safeParse(raw);
    if (!parsed.success) throw new PartnerExportCursorError();
    const cursor = normalizeCursor(parsed.data);
    const expectedUpdatedSince = expected.updatedSince === null
      ? null
      : normalizePartnerExportTimestamp(expected.updatedSince, 'updatedSince');
    if (
      cursor.partnerId !== expected.partnerId
      || cursor.resource !== expected.resource
      || cursor.updatedSince !== expectedUpdatedSince
      || canonicalJsonStringify(cursor.filters) !== canonicalJsonStringify(expected.filters)
      || Date.parse(cursor.expiresAt) <= now.getTime()
    ) {
      throw new PartnerExportCursorError();
    }
    return cursor;
  } catch (error) {
    if (error instanceof PartnerExportCursorError) throw error;
    throw new PartnerExportCursorError();
  }
}
