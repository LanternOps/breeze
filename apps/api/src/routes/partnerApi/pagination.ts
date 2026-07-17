import type { PartnerExportCursor } from './cursor';
import { partnerExportTimestampSchema } from './schemas';

export const PARTNER_EXPORT_DEFAULT_LIMIT = 100;
export const PARTNER_EXPORT_MAX_LIMIT = 500;

export class PartnerExportPaginationError extends Error {
  readonly status = 400;
  readonly code = 'invalid_partner_export_pagination';
}

function paginationError(message: string): PartnerExportPaginationError {
  return new PartnerExportPaginationError(message);
}

export function normalizePartnerExportLimit(value: string | number | undefined): number {
  if (value === undefined) return PARTNER_EXPORT_DEFAULT_LIMIT;
  if (typeof value === 'string' && !/^[1-9][0-9]*$/u.test(value)) {
    throw paginationError('Partner export limit must be a positive integer.');
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw paginationError('Partner export limit must be a positive integer.');
  }
  return Math.min(parsed, PARTNER_EXPORT_MAX_LIMIT);
}

export function getPartnerExportFetchLimit(limit: number): number {
  const normalized = normalizePartnerExportLimit(limit);
  return normalized + 1;
}

export interface PartnerExportPageKey {
  lastUpdatedAt: string | null;
  lastId: string;
  lastOrgId: string | null;
}

export interface PartnerExportTraversal {
  mode: 'incremental' | 'full';
  updatedSince: string | null;
  snapshotAt: string;
  after: PartnerExportPageKey | null;
}

function timestamp(value: string, field: string): number {
  const validated = partnerExportTimestampSchema.safeParse(value);
  if (!validated.success) {
    throw paginationError(`Partner export ${field} must be a strict offset ISO timestamp.`);
  }
  return Date.parse(validated.data);
}

export function normalizePartnerExportTimestamp(value: string, field = 'timestamp'): string {
  return new Date(timestamp(value, field)).toISOString();
}

export function createPartnerExportTraversal(input: {
  updatedSince: string | null;
  cursor: PartnerExportCursor | null;
  now?: Date;
}): PartnerExportTraversal {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw paginationError('Partner export snapshot time is invalid.');
  const updatedSince = input.updatedSince === null
    ? null
    : normalizePartnerExportTimestamp(input.updatedSince, 'updatedSince');
  if (!input.cursor) {
    return {
      mode: updatedSince === null ? 'full' : 'incremental',
      updatedSince,
      snapshotAt: now.toISOString(),
      after: null,
    };
  }
  if (input.cursor.updatedSince !== updatedSince) {
    throw paginationError('Partner export cursor filter does not match updatedSince.');
  }
  timestamp(input.cursor.snapshotAt, 'cursor snapshotAt');
  if (input.cursor.lastUpdatedAt !== null) {
    timestamp(input.cursor.lastUpdatedAt, 'cursor lastUpdatedAt');
  }
  return {
    mode: updatedSince === null ? 'full' : 'incremental',
    updatedSince,
    snapshotAt: input.cursor.snapshotAt,
    after: {
      lastUpdatedAt: input.cursor.lastUpdatedAt,
      lastId: input.cursor.lastId,
      lastOrgId: input.cursor.lastOrgId,
    },
  };
}

export interface PartnerExportPageRow {
  id: string;
  orgId: string | null;
  createdAt: string;
  updatedAt: string;
}

function compareStrings(left: string | null, right: string | null): number {
  const normalizedLeft = left ?? '';
  const normalizedRight = right ?? '';
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

function compareRowToKey(
  row: PartnerExportPageRow,
  key: PartnerExportPageKey,
  mode: PartnerExportTraversal['mode'],
): number {
  if (mode === 'incremental') {
    const updatedComparison = timestamp(row.updatedAt, 'row updatedAt') - timestamp(key.lastUpdatedAt!, 'cursor lastUpdatedAt');
    if (updatedComparison !== 0) return updatedComparison;
  }
  const idComparison = compareStrings(row.id, key.lastId);
  if (idComparison !== 0) return idComparison;
  return compareStrings(row.orgId, key.lastOrgId);
}

function keyForRow(row: PartnerExportPageRow, mode: PartnerExportTraversal['mode']): PartnerExportPageKey {
  return {
    lastUpdatedAt: mode === 'incremental' ? row.updatedAt : null,
    lastId: row.id,
    lastOrgId: row.orgId,
  };
}

function assertRowInSnapshot(row: PartnerExportPageRow, traversal: PartnerExportTraversal): void {
  const snapshot = timestamp(traversal.snapshotAt, 'snapshotAt');
  const createdAt = timestamp(row.createdAt, 'row createdAt');
  const updatedAt = timestamp(row.updatedAt, 'row updatedAt');
  if (traversal.mode === 'incremental') {
    const updatedSince = timestamp(traversal.updatedSince!, 'updatedSince');
    if (updatedAt <= updatedSince || updatedAt > snapshot) {
      throw paginationError('Partner export row falls outside the incremental snapshot window.');
    }
    return;
  }
  if (createdAt > snapshot) {
    throw paginationError('Partner export row falls outside the full snapshot window.');
  }
}

export function paginatePartnerExportRows<T extends PartnerExportPageRow>(
  rows: readonly T[],
  options: { traversal: PartnerExportTraversal; limit: number },
): { data: T[]; hasMore: boolean; lastKey: PartnerExportPageKey | null } {
  const limit = normalizePartnerExportLimit(options.limit);
  if (rows.length > getPartnerExportFetchLimit(limit)) {
    throw paginationError('Partner export query must fetch at most limit + 1 rows.');
  }
  let previous = options.traversal.after;
  for (const row of rows) {
    assertRowInSnapshot(row, options.traversal);
    if (previous && compareRowToKey(row, previous, options.traversal.mode) <= 0) {
      throw paginationError('Partner export page keys must strictly advance.');
    }
    previous = keyForRow(row, options.traversal.mode);
  }
  const data = rows.slice(0, limit) as T[];
  return {
    data,
    hasMore: rows.length > limit,
    lastKey: data.length === 0 ? null : keyForRow(data[data.length - 1]!, options.traversal.mode),
  };
}
