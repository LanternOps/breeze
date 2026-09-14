/**
 * Streaming writer behind `export_dataset` (spec §5.7).
 *
 * The whole point of this file is that a full-fidelity export NEVER
 * materialises in memory: a pager yields one page, the page is serialised and
 * pushed downstream, the page is dropped. `createArtifact` consumes the
 * `Readable` and counts bytes as they pass.
 *
 * CAPS ARE NOT ALL THE SAME KIND. Row and wall caps end the export CLEANLY and
 * set `truncated: true` — the model is told it has a prefix and can decide what
 * to do. The BYTE cap destroys the stream with a typed error, because a
 * truncated artifact that claims to be complete is worse than no artifact: the
 * sandbox would compute a confident answer over silently missing data.
 */
import { Readable } from 'node:stream';
import { csvRow } from './spreadsheetExport';

export type ExportFormat = 'jsonl' | 'csv';

export const EXPORT_DEFAULT_MAX_ROWS = 200_000;
export const EXPORT_HARD_MAX_ROWS = 1_000_000;
export const EXPORT_WALL_MS = 120_000;
/** Spec §5.4 `analysisMaxStagedBytesPerRun` default. W04's profile limit
 *  overrides this per run via `ToolExecutionContext.stagedBytesRemaining`. */
export const EXPORT_DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
export const EXPORT_DEVICE_CONCURRENCY = 4;
export const EXPORT_PREVIEW_BYTES = 2048;

export class ExportCapError extends Error {
  readonly code = 'artifact_bytes_exceeded' as const;

  constructor(bytes: number, maxBytes: number) {
    super(`Export exceeded the artifact byte cap (${bytes} > ${maxBytes} bytes)`);
    this.name = 'ExportCapError';
  }
}

export interface ExportPage {
  rows: Array<Record<string, unknown>>;
  nextCursor: string | null;
}

export type ExportPager = (cursor: string | null) => Promise<ExportPage>;

export interface ExportStats {
  rows: number;
  bytes: number;
  truncated: boolean;
  head: string;
  tail: string;
}

export interface ExportResult {
  body: NodeJS.ReadableStream;
  stats: Promise<ExportStats>;
}

/** Bounded-parallelism map. Duplicated locally rather than imported from
 *  `automationRuntime.ts` (a 2 700-line automation module) — `p-limit` is not a
 *  dependency of apps/api and this wave must not add one. */
export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  handler: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let current = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (current < items.length) {
      const index = current;
      current += 1;
      const item = items[index];
      if (item !== undefined) await handler(item, index);
    }
  });
  await Promise.all(workers);
}

export function buildExportStream(
  pager: ExportPager,
  opts: {
    format: ExportFormat;
    maxRows: number;
    maxBytes: number;
    wallMs: number;
    now?: () => number;
  },
): ExportResult {
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();

  let rows = 0;
  let bytes = 0;
  let truncated = false;
  let head = '';
  let tail = '';
  let headerWritten = false;

  let resolveStats: (stats: ExportStats) => void;
  let rejectStats: (error: unknown) => void;
  const stats = new Promise<ExportStats>((resolve, reject) => {
    resolveStats = resolve;
    rejectStats = reject;
  });

  function accountPreview(chunk: string): void {
    if (Buffer.byteLength(head) < EXPORT_PREVIEW_BYTES) {
      head = Buffer.from(head + chunk).subarray(0, EXPORT_PREVIEW_BYTES).toString('utf8');
    }
    const merged = tail + chunk;
    tail = Buffer.from(merged)
      .subarray(Math.max(0, Buffer.byteLength(merged) - EXPORT_PREVIEW_BYTES))
      .toString('utf8');
  }

  /**
   * `escapeCsvCell` (spreadsheetExport.ts) does `String(value ?? '')` — correct
   * for scalars, but `String({})` is the literal text `[object Object]`. Several
   * datasets carry a jsonb column verbatim (`agent_logs.fields`,
   * `custom_fields.value`), so CSV cells that are objects/arrays are
   * JSON-encoded here BEFORE reaching csvRow, same as jsonl already does by
   * construction (JSON.stringify(row)). Dates pass through untouched: csvRow
   * already special-cases them to ISO strings.
   */
  function csvCellValue(value: unknown): unknown {
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      return JSON.stringify(value);
    }
    return value;
  }

  function serialise(row: Record<string, unknown>): string {
    if (opts.format === 'jsonl') return `${JSON.stringify(row)}\n`;
    const keys = Object.keys(row);
    const line = `${csvRow(keys.map((k) => csvCellValue(row[k])))}\n`;
    if (headerWritten) return line;
    headerWritten = true;
    return `${csvRow(keys)}\n${line}`;
  }

  async function* generate(): AsyncGenerator<Buffer> {
    let cursor: string | null = null;
    for (;;) {
      const page: ExportPage = await pager(cursor);

      for (const row of page.rows) {
        if (rows >= opts.maxRows) {
          truncated = true;
          return;
        }
        const chunk = serialise(row);
        const chunkBytes = Buffer.byteLength(chunk);
        if (bytes + chunkBytes > opts.maxBytes) {
          throw new ExportCapError(bytes + chunkBytes, opts.maxBytes);
        }
        bytes += chunkBytes;
        rows += 1;
        accountPreview(chunk);
        yield Buffer.from(chunk);
      }

      if (!page.nextCursor) return;
      if (rows >= opts.maxRows) {
        truncated = true;
        return;
      }
      if (now() - startedAt >= opts.wallMs) {
        truncated = true;
        return;
      }
      cursor = page.nextCursor;
    }
  }

  const body = Readable.from(generate());
  body.on('end', () => resolveStats({ rows, bytes, truncated, head, tail }));
  body.on('error', (error) => rejectStats(error));

  return { body, stats };
}
