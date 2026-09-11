/**
 * #3205 W05: the read-only quote-line estimator.
 *
 * ONE snapshot per call, ONE result per line, PER-LINE degradation — the pattern
 * wave 2 established for listContracts. A single failing group marks that line
 * only. Reads never evaluate: getQuote does no counting at all, because the
 * quantity is persisted. Only the four write moments, the advisory endpoint and
 * the send-time drift check come through here.
 *
 * Must be called inside a DB access context (request for the editor, system for
 * the accept-adjacent paths). Never writes a membership row.
 */
import { and, eq } from 'drizzle-orm';
import { isQuoteLineSiteDeleted, type QuoteDeviceSetType } from '@breeze/shared';
import { countContractSeats } from './contractQuantities';
import { buildOrgDeviceSnapshot } from './contractSnapshot';
import { quantityFor } from './contractCoverage';
import { applyAllowance } from './contractAllowance';
import { computeLineTotal } from './invoiceMath';
import { quoteLines } from '../db/schema';
import type { DbExecutor } from './contractService';

export interface QuoteDeviceSetLine {
  id: string;
  /** For reporting only (drift toasts, error meta); never persisted here. */
  description: string;
  contractLineType: QuoteDeviceSetType;
  deviceRoles: string[] | null;
  deviceGroupId: string | null;
  deviceGroupName: string | null;
  siteId: string | null;
  siteName: string | null;
  includedQuantity: string | null;
  overageMode: 'bill' | 'flag' | null;
  overageUnitPrice: string | null;
}

export interface QuoteDeviceSetCount {
  lineId: string;
  /** What the helpers measured right now. */
  counted: number;
  /** applyAllowance(counted, line, 'included_units').billed — what goes on
   *  quote_lines.quantity. Equals `counted` with no allowance. */
  billed: number;
  included: number | null;
  overage: number;
  overageMode: 'bill' | 'flag' | null;
  /** Set instead of a number when this line could not be counted. The line's
   *  stored quantity is left untouched; nothing is ever silently zeroed. */
  error?: 'GROUP_EVALUATION_FAILED' | 'GROUP_DELETED' | 'SITE_DELETED';
}

const FAILED = (lineId: string, error: NonNullable<QuoteDeviceSetCount['error']>): QuoteDeviceSetCount =>
  ({ lineId, counted: 0, billed: 0, included: null, overage: 0, overageMode: null, error });

export async function countQuoteDeviceSetLines(
  orgId: string, lines: readonly QuoteDeviceSetLine[],
): Promise<QuoteDeviceSetCount[]> {
  if (lines.length === 0) return [];
  const groupIds = [...new Set(lines.map((l) => l.deviceGroupId).filter((id): id is string => !!id))];
  const { snapshot, groupErrors } = await buildOrgDeviceSnapshot(orgId, groupIds);
  const seats = lines.some((l) => l.contractLineType === 'per_seat') ? await countContractSeats(orgId) : 0;

  return lines.map((l) => {
    // A stamped name with a null id is the DELETED state (spec decision 4). Not
    // counted and not zeroed: a persisted stale count that reads as authoritative
    // is the silent failure this wave exists to remove.
    if (l.contractLineType === 'per_device_group' && l.deviceGroupId === null && l.deviceGroupName !== null) {
      return FAILED(l.id, 'GROUP_DELETED');
    }
    if (isQuoteLineSiteDeleted(l)) return FAILED(l.id, 'SITE_DELETED');
    if (l.deviceGroupId && (groupErrors.has(l.deviceGroupId) || !snapshot.groups.has(l.deviceGroupId))) {
      return FAILED(l.id, groupErrors.has(l.deviceGroupId) ? 'GROUP_EVALUATION_FAILED' : 'GROUP_DELETED');
    }
    const counted = l.contractLineType === 'per_seat'
      ? seats
      : quantityFor(snapshot, {
          lineType: l.contractLineType,
          siteId: l.siteId,
          deviceRoles: l.deviceRoles,
          deviceGroupId: l.deviceGroupId,
        });
    const r = applyAllowance(counted, {
      includedQuantity: l.includedQuantity,
      overageMode: l.overageMode,
      overageUnitPrice: l.overageUnitPrice,
    }, 'included_units');
    return {
      lineId: l.id,
      counted: r.counted,
      billed: r.billed,
      included: r.included,
      overage: r.overage,
      overageMode: r.overageMode,
      error: undefined,
    };
  });
}

/** Write the derived quantities and recompute each line's total. Errored lines
 *  are SKIPPED — their stored quantity stands. The caller runs
 *  recomputeAndPersist afterwards. */
export async function persistQuoteDeviceSetQuantities(
  tx: DbExecutor,
  quoteId: string,
  currencyCode: string,
  rows: ReadonlyArray<{ id: string; unitPrice: string }>,
  counts: readonly QuoteDeviceSetCount[],
): Promise<void> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const c of counts) {
    if (c.error) continue;
    const row = byId.get(c.lineId);
    if (!row) continue;
    const quantity = c.billed.toFixed(2);
    await tx.update(quoteLines)
      .set({ quantity, lineTotal: computeLineTotal(quantity, row.unitPrice, currencyCode) })
      .where(and(eq(quoteLines.id, c.lineId), eq(quoteLines.quoteId, quoteId)));
  }
}

/** A quote_lines row projected onto the estimator's input. `contractLineType`
 *  is non-null by construction — every caller filters on it first. */
export function toQuoteDeviceSetLine(row: {
  id: string;
  name: string | null;
  description: string | null;
  contractLineType: string | null;
  deviceRoles: string[] | null;
  deviceGroupId: string | null;
  deviceGroupName: string | null;
  siteId: string | null;
  siteName: string | null;
  includedQuantity: string | null;
  overageMode: string | null;
  overageUnitPrice: string | null;
}): QuoteDeviceSetLine {
  return {
    id: row.id,
    description: row.name ?? row.description ?? '',
    contractLineType: row.contractLineType as QuoteDeviceSetType,
    deviceRoles: row.deviceRoles,
    deviceGroupId: row.deviceGroupId,
    deviceGroupName: row.deviceGroupName,
    siteId: row.siteId,
    siteName: row.siteName,
    includedQuantity: row.includedQuantity,
    overageMode: row.overageMode as 'bill' | 'flag' | null,
    overageUnitPrice: row.overageUnitPrice,
  };
}
