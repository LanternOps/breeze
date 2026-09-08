/**
 * The `warranty` mapping target for the RMM value importer (#3257 W08 Task 4).
 *
 * WHY THIS EXISTS AT ALL (Open Decision 7). Warranty expiry is the flagship
 * column of an incumbent export, and importing it into a text custom field
 * ships the feature INERT: `device_warranty` — not `devices.custom_fields` — is
 * what feeds `warrantyAlertEvaluator.ts`, the warranty dashboard and
 * `routes/partnerApi/inventory.ts`, and `filterEngine` has no warranty field at
 * all. A migrating MSP would see their expiry dates land somewhere and no alert
 * ever fire.
 *
 * THE RULE THAT MAKES IT WORK: **compute and write `status`.**
 * `evaluateWarrantyAlerts` returns early on `status === 'unknown'`
 * (`warrantyAlertEvaluator.ts:200`) and the column DEFAULTS to `'unknown'`, so
 * writing `warranty_end_date` alone changes nothing an operator can see. The
 * status comes from `computeWarrantyStatus`, exported from `warrantySync.ts`
 * rather than copied, so the provider sync and the importer can never disagree
 * about what "expiring" means.
 *
 * TWO THINGS THIS DELIBERATELY WILL NOT DO:
 *
 *  1. **Clobber provider data without being asked.** `data_source = 'provider'`
 *     means a manufacturer's own API answered for this serial; that is more
 *     trustworthy than a hand-edited CSV. The refusal is enforced twice — the
 *     read below decides the reported outcome, and a `setWhere` on the
 *     statement is the authority, so a row that becomes provider-owned between
 *     the read and the write is still refused rather than silently overwritten.
 *  2. **Set `is_subscription`.** An import cannot know it, and a true value
 *     suppresses expiry alerting outright (`warrantyAlertEvaluator.ts:208`) —
 *     the exact failure this whole module exists to prevent, arrived at from
 *     the other direction.
 *
 * Called from inside the value importer's PER-ROW transaction, on that
 * transaction's handle, so a warranty failure rolls back that device's custom
 * field values too: one row, one atom.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { deviceWarranty } from '../../../db/schema';
import { computeWarrantyStatus } from '../../warrantySync';
import { normalizeManufacturer } from '../../warrantyProviders';
import type {
  CustomFieldImportRejection,
  WarrantyImportField,
  WarrantyImportOutcome,
} from './types';

/**
 * The nested-transaction handle. Every statement here MUST be issued on it and
 * never on the ambient `db` proxy: the proxy resolves (via AsyncLocalStorage) to
 * the OUTER request transaction, whose postgres.js scope would record the error
 * and poison the whole request — see `dbSavepointErrorIsolation.integration.test.ts`.
 */
export type WarrantyImportExecutor = Pick<
  Parameters<Parameters<typeof db.transaction>[0]>[0],
  'select' | 'insert'
>;

export interface WarrantyImportWrite {
  deviceId: string;
  orgId: string;
  /**
   * Present-but-undefined means "this file did not map that column" and leaves
   * the stored value alone. Present-and-null is an explicit clear. The two are
   * distinguished with `in`, never with a truthiness check, because clearing a
   * date has to remain expressible.
   */
  warrantyStartDate?: string | null;
  warrantyEndDate?: string | null;
  manufacturer?: string | null;
}

export type WarrantyValueResult =
  | { ok: true; value: string | null }
  | { ok: false; reason: CustomFieldImportRejection };

/** `device_warranty.manufacturer` is `varchar(100)`. */
const MAX_MANUFACTURER_LENGTH = 100;

/**
 * Validate and coerce ONE mapped warranty cell, mirroring what
 * `validateCustomFieldValue` does for a custom field: total, never throws, and
 * the only place that decides whether a warranty cell is acceptable.
 *
 * An empty cell is an explicit clear rather than an error, matching
 * `validateCustomFieldValue`'s treatment of a blank date input — a CSV column
 * that is populated for some rows and blank for others is the normal shape of
 * an incumbent export, not a file the operator has to repair first.
 */
export function coerceWarrantyValue(field: WarrantyImportField, raw: unknown): WarrantyValueResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };

  if (field === 'manufacturer') {
    if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false, reason: 'invalid_type' };
    const value = String(raw).trim();
    if (value === '') return { ok: true, value: null };
    if (value.length > MAX_MANUFACTURER_LENGTH) return { ok: false, reason: 'too_long' };
    return { ok: true, value };
  }

  // A date column. Numbers are refused rather than parsed: a bare epoch or an
  // Excel serial number in a date column is a mis-mapped column, and guessing
  // which of the two it is would silently date a warranty decades wrong.
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid_date' };
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: null };
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return { ok: false, reason: 'invalid_date' };
  // Stored as a plain calendar date, matching the `date` column type and
  // `validateCustomFieldValue`'s own date handling.
  return { ok: true, value: parsed.toISOString().slice(0, 10) };
}

/** True when the write names at least one warranty column. */
export function hasWarrantyColumns(write: WarrantyImportWrite): boolean {
  return 'warrantyStartDate' in write || 'warrantyEndDate' in write || 'manufacturer' in write;
}

export interface ExistingWarrantyRow {
  dataSource: string | null;
  warrantyStartDate: string | null;
  warrantyEndDate: string | null;
  manufacturer: string | null;
  status: string;
}

/**
 * Would writing `value` into `field` change anything?
 *
 * PREVIEW uses this so it annotates a warranty cell the way commit will treat
 * it, instead of promising `applied` for a re-import of an unchanged file. It
 * lives here, beside `applyWarrantyImport`, because the two must agree — and
 * the end-date case is the reason it cannot be a naive equality check: the
 * stored `status` is derived from that date and DECAYS with time, so a row
 * whose date is unchanged but whose status has since gone stale ('active' that
 * should now read 'expiring') must still be treated as a change, or the import
 * would quietly stop being the thing that refreshes it.
 */
export function warrantyCellUnchanged(
  field: WarrantyImportField,
  existing: ExistingWarrantyRow,
  value: string | null,
): boolean {
  if (field === 'manufacturer') {
    const incoming = value === null ? null : normalizeManufacturer(value);
    return (existing.manufacturer ?? null) === incoming;
  }
  if (field === 'warrantyStartDate') {
    return (existing.warrantyStartDate ?? null) === value;
  }
  return (existing.warrantyEndDate ?? null) === value
    && existing.status === computeWarrantyStatus(value);
}

function merge<T>(write: WarrantyImportWrite, key: keyof WarrantyImportWrite, existing: T): T {
  return key in write ? (write[key] as unknown as T) : existing;
}

export async function applyWarrantyImport(
  tx: WarrantyImportExecutor,
  write: WarrantyImportWrite,
  options: { overrideProvider: boolean },
): Promise<WarrantyImportOutcome> {
  if (!hasWarrantyColumns(write)) return 'none';

  const [existing] = (await tx
    .select({
      dataSource: deviceWarranty.dataSource,
      warrantyStartDate: deviceWarranty.warrantyStartDate,
      warrantyEndDate: deviceWarranty.warrantyEndDate,
      manufacturer: deviceWarranty.manufacturer,
      status: deviceWarranty.status,
    })
    .from(deviceWarranty)
    .where(eq(deviceWarranty.deviceId, write.deviceId))
    .limit(1)) as ExistingWarrantyRow[];

  // A manufacturer lookup outranks a hand-typed CSV. Refused here so the
  // operator gets `skipped-provider-owned` rather than a silent no-op.
  if (existing && existing.dataSource === 'provider' && !options.overrideProvider) {
    return 'skipped-provider-owned';
  }

  const rawManufacturer = merge<string | null>(write, 'manufacturer', existing?.manufacturer ?? null);
  const manufacturer = rawManufacturer === null ? null : normalizeManufacturer(rawManufacturer);
  const warrantyStartDate = merge<string | null>(write, 'warrantyStartDate', existing?.warrantyStartDate ?? null);
  const warrantyEndDate = merge<string | null>(write, 'warrantyEndDate', existing?.warrantyEndDate ?? null);
  // Recomputed from the MERGED end date, not from this file's cell: a row that
  // maps only a manufacturer must not leave a status contradicting the dates
  // already stored.
  const status = computeWarrantyStatus(warrantyEndDate);

  if (
    existing &&
    existing.warrantyStartDate === warrantyStartDate &&
    existing.warrantyEndDate === warrantyEndDate &&
    existing.manufacturer === manufacturer &&
    existing.status === status
  ) {
    // Nothing would change. Reported honestly, and — as with
    // `persistDeviceCustomFieldValues`' compare-before-write — no UPDATE is
    // issued, so a re-imported file does not take a per-org export lock per
    // device for a no-op.
    return 'skipped-already-set';
  }

  const columns = {
    manufacturer,
    warrantyStartDate,
    warrantyEndDate,
    status,
    // 'import' is a distinct provenance from 'provider' and 'agent_plist', so
    // the NEXT provider sync can tell it apart. `is_subscription` is never set
    // here — see the module header.
    dataSource: 'import' as const,
  };

  const written = await tx
    .insert(deviceWarranty)
    .values({ deviceId: write.deviceId, orgId: write.orgId, ...columns })
    .onConflictDoUpdate({
      target: deviceWarranty.deviceId,
      // device_warranty_device_id_idx became PARTIAL in #4622 W03 (device_id is
      // now nullable — a warranty row's subject is a device XOR a manual
      // asset). Postgres only infers a partial unique index as the ON CONFLICT
      // arbiter when the statement repeats the predicate, so omitting this
      // raises 42P10 on every imported warranty row.
      targetWhere: sql`${deviceWarranty.deviceId} IS NOT NULL`,
      set: { ...columns, orgId: write.orgId, updatedAt: new Date() },
      // The AUTHORITY on the provider rule; the read above is advisory. A row
      // that turns provider-owned between the two matches no target here and
      // the statement writes nothing rather than clobbering it.
      ...(options.overrideProvider
        ? {}
        : {
            setWhere: and(
              sql`${deviceWarranty.dataSource} IS DISTINCT FROM 'provider'`,
            ),
          }),
    })
    .returning({ id: deviceWarranty.id });

  // No row means the guard blocked the update. Never report that as applied.
  return written.length > 0 ? 'applied' : 'skipped-provider-owned';
}
