import { normalizeStartupItems } from './startupItems';

export interface BootHistoryRecord {
  bootTimestamp: Date | string;
  biosSeconds: number | null;
  osLoaderSeconds: number | null;
  desktopReadySeconds: number | null;
  totalBootSeconds: number | null;
  startupItemCount: number;
  startupItems: unknown[];
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function parseNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fallback;
}

function toRecord(raw: Record<string, unknown>): BootHistoryRecord | null {
  const bootTimestamp = parseDate(raw.bootTimestamp);
  if (!bootTimestamp) return null;

  const startupItems = normalizeStartupItems(
    Array.isArray(raw.startupItems) ? raw.startupItems : []
  );

  return {
    bootTimestamp,
    biosSeconds: parseNumber(raw.biosSeconds, 0),
    osLoaderSeconds: parseNumber(raw.osLoaderSeconds, 0),
    desktopReadySeconds: parseNumber(raw.desktopReadySeconds, 0),
    totalBootSeconds: parseNumber(raw.totalBootSeconds, 0),
    startupItemCount: Number.isFinite(Number(raw.startupItemCount))
      ? Math.max(0, Math.trunc(Number(raw.startupItemCount)))
      : startupItems.length,
    startupItems,
  };
}

export function parseCollectorBootMetricsFromCommandResult(result: {
  status?: string;
  stdout?: string;
  data?: unknown;
}): BootHistoryRecord | null {
  if (result.status !== 'completed') return null;

  let payload: unknown = result.data;
  if (payload === undefined && typeof result.stdout === 'string' && result.stdout.trim() !== '') {
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      return null;
    }
  }

  if (!payload || typeof payload !== 'object') return null;
  return toRecord(payload as Record<string, unknown>);
}

function bootRecordSortKey(record: BootHistoryRecord): number {
  const parsed = parseDate(record.bootTimestamp);
  return parsed?.getTime() ?? 0;
}

function bootRecordIdentity(record: BootHistoryRecord): string {
  const parsed = parseDate(record.bootTimestamp);
  return parsed ? String(parsed.getTime()) : String(record.bootTimestamp);
}

export function mergeBootRecords(
  existing: BootHistoryRecord[],
  fresh: BootHistoryRecord | null,
  limit: number
): BootHistoryRecord[] {
  const merged: BootHistoryRecord[] = [];
  const seen = new Set<string>();

  const pushIfNew = (record: BootHistoryRecord | null) => {
    if (!record) return;
    const key = bootRecordIdentity(record);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(record);
  };

  // Fresh collection takes precedence for duplicate timestamps.
  pushIfNew(fresh);
  for (const record of existing) pushIfNew(record);

  merged.sort((a, b) => bootRecordSortKey(b) - bootRecordSortKey(a));
  return merged.slice(0, limit);
}

