export interface BulkResult {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
  skippedReasons: Record<string, number>;
}

const SKIP_STATUSES = new Set([400, 403, 404, 409]);

function asServiceError(err: unknown): { status: number; code?: string; message?: string } | null {
  if (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
    return err as { status: number; code?: string; message?: string };
  }
  return null;
}

/**
 * Run a per-item async operation over a list of ids, isolating per-item failures.
 * Expected 4xx service errors (not-a-draft, org-denied, not-found, invalid-state)
 * count as `skipped` (tallied by `.code`); anything else counts as `failed`.
 */
export async function runBulk(
  ids: string[],
  perItem: (id: string) => Promise<unknown>
): Promise<BulkResult> {
  const result: BulkResult = { total: ids.length, succeeded: 0, skipped: 0, failed: 0, skippedReasons: {} };
  for (const id of ids) {
    try {
      await perItem(id);
      result.succeeded++;
    } catch (err) {
      const svc = asServiceError(err);
      if (svc && SKIP_STATUSES.has(svc.status)) {
        result.skipped++;
        const code = svc.code ?? 'OTHER';
        result.skippedReasons[code] = (result.skippedReasons[code] ?? 0) + 1;
      } else {
        result.failed++;
        console.error('[runBulk] item failed:', id, err instanceof Error ? err.message : err);
      }
    }
  }
  return result;
}
