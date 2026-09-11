/**
 * Custom-field VALUE import pipeline: preview -> commit (#3257 W08).
 *
 * The second and larger half of the RMM importer. W07 created the DEFINITIONS;
 * this backfills their values onto enrolled devices, plus the `warranty`
 * mapping target that makes the flagship migration use case actually work.
 *
 * ── Per VALUE, not per row ──────────────────────────────────────────────────
 * The shape decision everything else follows from. One device row carries up to
 * thirty mapped columns, and the NORMAL case is mixed: twenty-eight land, one
 * names a field this organization never defined, one holds `abc` in a number
 * column. A row-level annotation cannot express that, and an all-or-nothing row
 * would refuse a whole migration over one bad cell. So `no-definition`,
 * `type-error`, `skipped-already-set` and the `skip`/`update` conflict policy
 * are all per VALUE; only device resolution is per row.
 *
 * ── Where the reads happen ──────────────────────────────────────────────────
 * TWO separate escalations to a SYSTEM db context, for two different reasons.
 * They are easy to conflate and the distinction matters, so:
 *
 *  1. **Device resolution** — W06's `loadDeviceResolutionSnapshot`. It escalates
 *     because a partner's import legitimately spans that partner's
 *     organizations; see its own header. It reads `organizations`, `devices`,
 *     `device_hardware` and `device_external_links`, and touches
 *     `custom_field_definitions` not at all. RLS is NOT the boundary on that
 *     read — the organization and site predicates W06 carries IN ITS SQL are
 *     the whole of it, and this module never widens the scope it is handed.
 *  2. **Visible definitions** — W04's `loadVisibleCustomFieldDefinitions`,
 *     called once per resolved organization below. It escalates for an
 *     unrelated reason, and that reason has now EXPIRED:
 *     `custom_field_definitions` used to have no partner-wide RLS SELECT branch
 *     (it was the last entry in `PARTNER_WIDE_SELECT_BRANCH_EXEMPT`), so an
 *     org-scoped request context could not see a partner-wide definition at all
 *     and every value naming one would be annotated `no-definition`. #4944
 *     added that branch, so the escalation inside that function is now
 *     redundant and is retained only pending a separate follow-up. Either way
 *     it says nothing about (1) — do not read (1)'s scope out of it.
 *
 * Everything else — the already-stored values, the existing warranty rows — is
 * read in the REQUEST's own context, deliberately. Those reads are bounded to
 * devices the snapshot already admitted, and running them under RLS keeps a
 * second, independent control on exactly the rows the writes will later touch:
 * if the request context cannot see a device, it cannot write it either, and the
 * two agree by construction rather than by review.
 *
 * ── Where the WRITES happen ─────────────────────────────────────────────────
 * Each row's writes run in a NESTED `db.transaction` — a SAVEPOINT inside the
 * request's own `withDbAccessContext` transaction
 * (`dbSavepointErrorIsolation.integration.test.ts` is the proof), the same shape
 * W07 shipped. That buys per-row failure isolation (without it, one failed
 * statement aborts the request transaction and every later row raises 25P02)
 * while keeping RLS a real control on every write.
 *
 * The plan called for `runOutsideDbContext` here. That would have bypassed RLS
 * on the write path for a bulk cross-organization tool, which is precisely where
 * it is least affordable — so this follows W07's shipped pattern instead.
 *
 * EVERY statement inside a row transaction MUST be issued on that callback's
 * `tx`. The ambient `db` proxy still resolves to the OUTER transaction, whose
 * postgres.js scope would record the error and poison the request — which is why
 * `persistDeviceCustomFieldValues` takes an executor rather than being forked.
 *
 * ── TOCTOU ──────────────────────────────────────────────────────────────────
 * Commit re-derives resolution and every annotation against state loaded at
 * commit time and never trusts preview's. A row whose outcome moved is refused
 * (`annotation-changed`); an ambiguous row must carry an identity PIN naming the
 * device the operator chose, and the pin is re-checked against the candidate set
 * as it stands now (`match-unconfirmed` / `match-changed`). A link-match needs no
 * acknowledgement — the durable `device_external_links` row IS the operator's
 * earlier acknowledgement, made once and reused on every subsequent run.
 */

import { inArray } from 'drizzle-orm';
import { db } from '../../../db';
import { deviceCustomFieldValues, deviceExternalLinks, deviceWarranty } from '../../../db/schema';
import { pgErrorCode, pgErrorNode } from '../../../utils/pgErrors';
import {
  loadVisibleCustomFieldDefinitions,
  persistDeviceCustomFieldValues,
  valueColumnsFor,
  type CustomFieldValueColumns,
  type CustomFieldValueWrite,
  type VisibleCustomFieldDefinition,
} from '../queries';
import { validateCustomFieldValue, type CustomFieldValueRejection } from '../validateValue';
import {
  loadDeviceResolutionSnapshot,
  resolveDeviceRow,
  type DeviceResolutionScope,
} from './resolveDevice';
import {
  applyWarrantyImport,
  coerceWarrantyValue,
  warrantyCellUnchanged,
  type ExistingWarrantyRow,
  type WarrantyImportWrite,
} from './warrantyTarget';
import { captureException } from '../../sentry';
import {
  DEFAULT_IMPORT_SYSTEM,
  type AnnotatedImportValue,
  type AnnotatedValueRow,
  type CommitValueRowInput,
  type CustomFieldImportRejection,
  type DeviceCustomFieldImportRow,
  type DeviceCustomFieldImportValue,
  type DeviceMatchMethod,
  type DeviceResolution,
  type MappingTarget,
  type ValueImportErrorCode,
  type ValueImportErrorEntry,
  type ValueImportMode,
  type ValueImportRowResult,
  type ValueImportSummary,
  type WarrantyImportField,
  type WarrantyImportOutcome,
} from './types';

export type * from './types';
export { MAX_IMPORT_ROWS, MAX_IMPORT_VALUES } from './types';

/**
 * `types.ts` restates the rejection vocabulary structurally to keep its
 * no-imports rule. This conversion is the compile-time proof that the two agree:
 * a new reason in `validateValue.ts` that nobody added to the wire type fails
 * the build HERE, instead of reaching a client as an unmodelled string.
 */
function asImportRejection(reason: CustomFieldValueRejection): CustomFieldImportRejection {
  return reason;
}

/** What the importer is allowed to see and do, resolved once at the route. */
export interface ValueImportContext extends DeviceResolutionScope {
  /** Default `skip`, verbatim from the contacts importer. */
  mode?: ValueImportMode;
  /** Decision 7: an operator opt-in, off by default. */
  overrideProviderWarranty?: boolean;
}

export interface ValueImportActor {
  userId: string | null;
}

/**
 * Custom-field keys `routes/partnerApi/devices.ts` republishes as a device's
 * `stableIdentifiers` to every integration the partner has connected
 * (`stringCustomIdentifier(row.customFields, [...])`). Importing one is
 * intended — that IS the migration — but doing it fleet-wide without being told
 * is not, so preview says so on the value rather than after the fact.
 */
const RESERVED_IDENTITY_KEYS = new Set([
  'assetTag', 'asset_tag',
  'inventoryId', 'inventory_id',
  'externalId', 'external_id',
]);

const RESERVED_IDENTITY_WARNING =
  'This key feeds the device\'s partner integration identity (stableIdentifiers), '
  + 'which is republished to every connected integration';

const PROVIDER_WARRANTY_WARNING =
  'A manufacturer warranty lookup already owns this device\'s warranty data — '
  + 'enable "override provider warranty" to replace it';

interface StoredValue extends CustomFieldValueColumns {
  definitionId: string;
}

/** Identity of a mapped target, for de-duplicating within one row. */
function targetKey(target: MappingTarget): string {
  return target.kind === 'customField' ? `field\u0000${target.fieldKey}` : `warranty\u0000${target.field}`;
}

/** The device a row will actually be written to, once resolution and any pin agree. */
interface RowTarget {
  deviceId: string;
  orgId: string;
  method: DeviceMatchMethod;
  osType: string | null;
}

interface AnnotationState {
  /** `orgId` -> `field_key` -> definition visible to that organization. */
  definitionsByOrg: Map<string, Map<string, VisibleCustomFieldDefinition>>;
  /** `deviceId` -> `definitionId` -> the value already stored. */
  storedByDevice: Map<string, Map<string, StoredValue>>;
  /**
   * `deviceId` -> the existing warranty row. The whole row, not just its
   * provenance: preview compares each mapped cell against it so it annotates a
   * re-import the way commit will actually treat it.
   */
  warrantyByDevice: Map<string, ExistingWarrantyRow>;
  mode: ValueImportMode;
  overrideProviderWarranty: boolean;
}

/**
 * Resolution plus the device it settles on. `target` is null whenever no single
 * device is established — including an ambiguous row whose pin does not name a
 * current candidate, which the commit loop then reports precisely.
 */
interface ResolvedRow {
  resolution: DeviceResolution;
  target: RowTarget | null;
}

function pinnedDeviceId(row: DeviceCustomFieldImportRow): string | undefined {
  return (row as CommitValueRowInput).expectedDeviceId;
}

function resolveRows(
  rows: readonly DeviceCustomFieldImportRow[],
  snapshot: Awaited<ReturnType<typeof loadDeviceResolutionSnapshot>>,
): ResolvedRow[] {
  return rows.map((row) => {
    const resolution = resolveDeviceRow(row, snapshot);

    const toTarget = (deviceId: string, method: DeviceMatchMethod): RowTarget | null => {
      const record = snapshot.devices.get(deviceId);
      return record ? { deviceId, orgId: record.orgId, method, osType: record.osType } : null;
    };

    if (resolution.deviceId && resolution.method) {
      return { resolution, target: toTarget(resolution.deviceId, resolution.method) };
    }

    // An ambiguous row is writable ONLY against an explicit, still-valid pick.
    if (resolution.outcome === 'ambiguous') {
      const pin = pinnedDeviceId(row);
      const candidate = pin ? resolution.candidates.find((c) => c.deviceId === pin) : undefined;
      if (candidate) return { resolution, target: toTarget(candidate.deviceId, candidate.method) };
    }

    return { resolution, target: null };
  });
}

async function loadAnnotationState(
  resolved: readonly ResolvedRow[],
  ctx: ValueImportContext,
): Promise<AnnotationState> {
  const state: AnnotationState = {
    definitionsByOrg: new Map(),
    storedByDevice: new Map(),
    warrantyByDevice: new Map(),
    mode: ctx.mode ?? 'skip',
    overrideProviderWarranty: ctx.overrideProviderWarranty ?? false,
  };

  const deviceIds = [...new Set(resolved.map((r) => r.target?.deviceId).filter((id): id is string => !!id))];
  const orgIds = [...new Set(resolved.map((r) => r.target?.orgId).filter((id): id is string => !!id))];
  if (deviceIds.length === 0) return state;

  // ONE call per DISTINCT organization, not per row. `loadVisibleCustomFieldDefinitions`
  // (W04) is reused rather than re-implemented as a batched query, because it
  // owns the org-XOR-partner visibility rule and a second copy of that rule is
  // exactly the kind of drift the partner-wide retrofits cost us. It does open a
  // system context per call (#1105); a file spanning dozens of organizations
  // would be worth batching, and this is where that would go.
  for (const orgId of orgIds) {
    const definitions = await loadVisibleCustomFieldDefinitions(orgId);
    state.definitionsByOrg.set(orgId, new Map(definitions.map((d) => [d.fieldKey, d])));
  }

  // Ambient REQUEST context (see the module header): bounded to devices the
  // snapshot already admitted, and under the same RLS the writes will run.
  const stored = (await db
    .select({
      deviceId: deviceCustomFieldValues.deviceId,
      definitionId: deviceCustomFieldValues.definitionId,
      valueText: deviceCustomFieldValues.valueText,
      valueNumber: deviceCustomFieldValues.valueNumber,
      valueBool: deviceCustomFieldValues.valueBool,
      valueDate: deviceCustomFieldValues.valueDate,
    })
    .from(deviceCustomFieldValues)
    .where(inArray(deviceCustomFieldValues.deviceId, deviceIds))) as Array<StoredValue & { deviceId: string }>;

  for (const row of stored) {
    let byDefinition = state.storedByDevice.get(row.deviceId);
    if (!byDefinition) {
      byDefinition = new Map();
      state.storedByDevice.set(row.deviceId, byDefinition);
    }
    byDefinition.set(row.definitionId, row);
  }

  const warranty = (await db
    .select({
      deviceId: deviceWarranty.deviceId,
      dataSource: deviceWarranty.dataSource,
      status: deviceWarranty.status,
      warrantyStartDate: deviceWarranty.warrantyStartDate,
      warrantyEndDate: deviceWarranty.warrantyEndDate,
      manufacturer: deviceWarranty.manufacturer,
    })
    .from(deviceWarranty)
    .where(inArray(deviceWarranty.deviceId, deviceIds))) as Array<ExistingWarrantyRow & { deviceId: string }>;

  for (const row of warranty) state.warrantyByDevice.set(row.deviceId, row);

  return state;
}

function sameStoredValue(stored: CustomFieldValueColumns, columns: CustomFieldValueColumns): boolean {
  const date = (value: string | null): string | null => (value === null ? null : String(value).slice(0, 10));
  return (
    (stored.valueText ?? null) === columns.valueText
    && (stored.valueNumber ?? null) === columns.valueNumber
    && (stored.valueBool ?? null) === columns.valueBool
    && date(stored.valueDate ?? null) === date(columns.valueDate)
  );
}

/**
 * One value's annotation plus, when it would be written, the resolved payload.
 * Kept together so commit never re-derives (and never re-validates) what preview
 * already decided for that row in the same pass.
 */
interface ValueDecision {
  annotation: AnnotatedImportValue;
  fieldWrite?: CustomFieldValueWrite;
  warrantyWrite?: { field: WarrantyImportField; value: string | null };
}

function decideValue(
  entry: DeviceCustomFieldImportValue,
  target: RowTarget | null,
  state: AnnotationState,
): ValueDecision {
  const { target: mapping } = entry;

  // No single device means no organization, and therefore no definitions to
  // judge this value against. Saying so is more useful than borrowing an
  // annotation that means something else.
  if (!target) return { annotation: { target: mapping, outcome: 'device-unresolved' } };

  if (mapping.kind === 'warranty') {
    const coerced = coerceWarrantyValue(mapping.field, entry.value);
    if (!coerced.ok) {
      return { annotation: { target: mapping, outcome: 'type-error', reason: coerced.reason } };
    }
    const existing = state.warrantyByDevice.get(target.deviceId);
    if (existing?.dataSource === 'provider' && !state.overrideProviderWarranty) {
      return {
        annotation: { target: mapping, outcome: 'skipped-provider-owned', warning: PROVIDER_WARRANTY_WARNING },
      };
    }
    // Compared against the STORED row, exactly as the custom-field branch does
    // below. Without this, a re-import of an unchanged file previews every
    // warranty cell as `applied` and then commits it as skipped — preview and
    // commit disagreeing on the one surface whose whole job is to predict the
    // other.
    if (existing && warrantyCellUnchanged(mapping.field, existing, coerced.value)) {
      return { annotation: { target: mapping, outcome: 'skipped-already-set' } };
    }
    return {
      annotation: { target: mapping, outcome: 'applied' },
      warrantyWrite: { field: mapping.field, value: coerced.value },
    };
  }

  const definition = state.definitionsByOrg.get(target.orgId)?.get(mapping.fieldKey);
  if (!definition) return { annotation: { target: mapping, outcome: 'no-definition' } };

  // The same gate `validateValueMap` applies on the PATCH paths: a null
  // (unknown) osType is treated as non-matching, never as a wildcard.
  if (
    Array.isArray(definition.deviceTypes)
    && definition.deviceTypes.length > 0
    && (target.osType === null || !definition.deviceTypes.includes(target.osType))
  ) {
    return { annotation: { target: mapping, outcome: 'not-applicable-to-device' } };
  }

  // ONE validator, shared with the script write-back and both PATCH paths.
  const result = validateCustomFieldValue(definition, entry.value);
  if (!result.ok) {
    return { annotation: { target: mapping, outcome: 'type-error', reason: asImportRejection(result.reason) } };
  }

  const columns = valueColumnsFor(definition.type, result.value);
  const stored = state.storedByDevice.get(target.deviceId)?.get(definition.id);
  if (stored && (state.mode === 'skip' || sameStoredValue(stored, columns))) {
    // Both readings of "already set": an identical re-import (a no-op in either
    // mode) and a differing value the default `skip` mode declines to overwrite.
    return { annotation: { target: mapping, outcome: 'skipped-already-set' } };
  }

  return {
    annotation: {
      target: mapping,
      outcome: 'applied',
      ...(RESERVED_IDENTITY_KEYS.has(mapping.fieldKey) ? { warning: RESERVED_IDENTITY_WARNING } : {}),
    },
    fieldWrite: {
      definitionId: definition.id,
      fieldKey: definition.fieldKey,
      type: definition.type,
      value: result.value,
    },
  };
}

function annotateRow(
  index: number,
  { resolution, target }: ResolvedRow,
  decisions: readonly ValueDecision[],
): AnnotatedValueRow {
  return {
    index,
    outcome: resolution.outcome,
    deviceId: target?.deviceId ?? resolution.deviceId,
    method: target?.method ?? resolution.method,
    organizationId: target?.orgId ?? null,
    candidates: resolution.candidates,
    ...(resolution.conflictingMethods ? { conflictingMethods: resolution.conflictingMethods } : {}),
    ...(resolution.discardedIdentifiers ? { discardedIdentifiers: resolution.discardedIdentifiers } : {}),
    values: decisions.map((d) => d.annotation),
  };
}

/** Resolve, load and annotate in one pass. Shared verbatim by preview and commit. */
async function deriveRows(
  rows: readonly DeviceCustomFieldImportRow[],
  ctx: ValueImportContext,
): Promise<Array<{ resolved: ResolvedRow; decisions: ValueDecision[]; annotated: AnnotatedValueRow }>> {
  const snapshot = await loadDeviceResolutionSnapshot(rows, ctx);
  const resolved = resolveRows(rows, snapshot);
  const state = await loadAnnotationState(resolved, ctx);

  return rows.map((row, index) => {
    const decisions = row.values.map((entry) => decideValue(entry, resolved[index]!.target, state));
    return { resolved: resolved[index]!, decisions, annotated: annotateRow(index, resolved[index]!, decisions) };
  });
}

export async function previewDeviceCustomFieldImport(
  rows: readonly DeviceCustomFieldImportRow[],
  ctx: ValueImportContext,
): Promise<AnnotatedValueRow[]> {
  return (await deriveRows(rows, ctx)).map((r) => r.annotated);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Commit
 * ────────────────────────────────────────────────────────────────────────── */

interface RowProblem {
  error: string;
  code: ValueImportErrorCode;
}

/**
 * Resolution outcomes that can never be acknowledged into a write, mapped to the
 * error code that says why. Keyed by the outcome union rather than `string` so
 * renaming an outcome fails the build instead of falling through.
 */
const REFUSED_OUTCOMES: Partial<Record<DeviceResolution['outcome'], ValueImportErrorCode>> = {
  'not-found': 'not-found',
  'org-not-found': 'org-not-found',
  'identity-conflict': 'identity-conflict',
};

const REFUSAL_COPY: Partial<Record<DeviceResolution['outcome'], string>> = {
  'not-found': 'No device in reach matches the identifiers on this row',
  'org-not-found': 'That organization was not found',
  'identity-conflict': 'The identifiers on this row point at different devices — correct the file and re-run preview',
};

/**
 * Validate the client's acknowledgement against the freshly re-derived
 * resolution. Order matters: the outcome guard runs first, then identity
 * pinning, so a row whose whole story changed says so before it is asked about
 * a device it no longer resolves to.
 */
function checkExpectation(row: CommitValueRowInput, { resolution, target }: ResolvedRow): RowProblem | null {
  if (row.expectedOutcome && row.expectedOutcome !== resolution.outcome) {
    return {
      code: 'annotation-changed',
      error: `Match changed since preview: expected "${row.expectedOutcome}", now "${resolution.outcome}" — re-run preview`,
    };
  }

  if (resolution.outcome === 'ambiguous') {
    if (!row.expectedDeviceId) {
      return {
        code: 'match-unconfirmed',
        error: 'Several devices match this row — pick one and resubmit it with expectedDeviceId',
      };
    }
    if (!target) {
      return {
        code: 'match-changed',
        error: 'The device this row was pinned to is no longer one of its candidates — re-run preview',
      };
    }
    return null;
  }

  if (row.expectedDeviceId && row.expectedDeviceId !== resolution.deviceId) {
    return {
      code: 'match-changed',
      error: 'This row now resolves to a different device than the one it was pinned to — re-run preview',
    };
  }
  return null;
}

/**
 * Fixed copy per SQLSTATE. A postgres.js `.message` carries the failing
 * statement's detail — column values, constraint text, sometimes the query — so
 * it is customer data and schema disclosure in one string and must never reach a
 * response body.
 */
const WRITE_FAILURE_COPY: Record<string, string> = {
  '23503': 'This device, or a custom field it names, no longer exists',
  '23505': 'Another write to this device raced this import — re-run it for this row',
  '23514': 'A value on this row violates a constraint on the field it targets',
  '22001': 'A value on this row is too long for the field it targets',
  '42501': 'You do not have access to write values for this device',
};
const GENERIC_WRITE_FAILURE = 'Could not write this device — check the server log for details';

function writeFailure(err: unknown): RowProblem {
  const code = pgErrorCode(err);
  return { error: (code && WRITE_FAILURE_COPY[code]) ?? GENERIC_WRITE_FAILURE, code: 'write-failed' };
}

/**
 * Attach the thrown error WITHOUT making it serializable: routes hand this
 * summary straight to `c.json(...)`. Read `entry.cause` in-process; never
 * serialize it.
 */
function withCause(entry: ValueImportErrorEntry, cause: unknown): ValueImportErrorEntry {
  Object.defineProperty(entry, 'cause', { value: cause, enumerable: false, writable: false });
  return entry;
}

interface RowWriteResult {
  changedFieldKeys: string[];
  linkCreated: boolean;
  warranty: WarrantyImportOutcome;
}

/**
 * ONE transaction for one device row: its values, its durable link, and its
 * warranty. A failure anywhere rolls back that device only — one row, one atom —
 * and the rows after it still commit.
 */
async function writeRow(
  row: CommitValueRowInput,
  target: RowTarget,
  decisions: readonly ValueDecision[],
  ctx: ValueImportContext,
  actor: ValueImportActor,
): Promise<RowWriteResult> {
  const fieldWrites = decisions.map((d) => d.fieldWrite).filter((w): w is CustomFieldValueWrite => !!w);

  const warrantyWrite: WarrantyImportWrite = { deviceId: target.deviceId, orgId: target.orgId };
  let hasWarranty = false;
  for (const decision of decisions) {
    if (!decision.warrantyWrite) continue;
    warrantyWrite[decision.warrantyWrite.field] = decision.warrantyWrite.value;
    hasWarranty = true;
  }
  // A warranty column WAS mapped and produced no write. WHY it produced none is
  // the operator-facing answer, and each reason is a different next step:
  // provider-owned (flip the override), already-set (nothing to do), or every
  // mapped cell refused (fix the file). `none` is reserved for "no warranty
  // column was mapped at all".
  const warrantyAnnotations = decisions
    .filter((d) => d.annotation.target.kind === 'warranty')
    .map((d) => d.annotation.outcome);
  const declinedWarranty: WarrantyImportOutcome | null =
    warrantyAnnotations.length === 0
      ? null
      : warrantyAnnotations.includes('skipped-provider-owned')
        ? 'skipped-provider-owned'
        : warrantyAnnotations.includes('skipped-already-set')
          ? 'skipped-already-set'
          : 'rejected';

  const externalId = row.externalId?.trim();
  // Only mint a link when the row was resolved some OTHER way — a link-match
  // already has one, and re-asserting it would be a write per row per run.
  const needsLink = !!externalId && target.method !== 'link';
  // The SAME key derivation W06's resolver uses, so the row the next run looks
  // up is the row this one wrote. A batch-level default here would silently
  // break re-resolution.
  const linkSystem = row.externalSystem?.trim() || DEFAULT_IMPORT_SYSTEM;

  return db.transaction(async (tx) => {
    // Every statement below is issued on `tx`. Issuing on the ambient `db` proxy
    // would record a failure against the OUTER request transaction and destroy
    // the per-row isolation this whole structure exists for.
    const changedFieldKeys = await persistDeviceCustomFieldValues(
      target.deviceId,
      target.orgId,
      fieldWrites,
      'import',
      tx,
    );

    let linkCreated = false;
    if (needsLink) {
      const created = await tx
        .insert(deviceExternalLinks)
        .values({
          deviceId: target.deviceId,
          orgId: target.orgId,
          partnerId: ctx.partnerId,
          system: linkSystem,
          sourceInstance: row.externalSourceInstance ?? null,
          externalId: externalId!,
          createdBy: actor.userId,
        })
        // Untargeted on purpose: the shipped unique index keys on
        // `COALESCE(source_instance, '')`, and a concurrent run that minted the
        // same link first is a no-op, not a failure.
        .onConflictDoNothing()
        .returning({ id: deviceExternalLinks.id });
      linkCreated = created.length > 0;
    }

    const warranty = hasWarranty
      ? await applyWarrantyImport(tx, warrantyWrite, { overrideProvider: ctx.overrideProviderWarranty ?? false })
      : (declinedWarranty ?? 'none');

    return { changedFieldKeys, linkCreated, warranty };
  });
}

function tallyRow(
  index: number,
  row: CommitValueRowInput,
  target: RowTarget,
  decisions: readonly ValueDecision[],
  written: RowWriteResult,
): ValueImportRowResult {
  const changed = new Set(written.changedFieldKeys);
  let applied = 0;
  let skipped = 0;
  let failed = 0;

  // A row that maps two columns onto the SAME target writes one datum — the
  // last one wins, in the database and here. Without this, both decisions would
  // find their key in `changed` and `applied` would be inflated by one per
  // duplicate, corrupting the very count an operator reconciles the file
  // against. The wire schema refuses such a row outright
  // (`routes/devices/customFieldImport.ts`); this keeps the tally honest for a
  // direct caller of the service, which is reachable and must fail safe.
  // Only a decision that would actually WRITE can supersede an earlier one — a
  // later column that failed validation wrote nothing and must not demote the
  // value that did land.
  const lastWriterByTarget = new Map<string, number>();
  decisions.forEach((decision, index) => {
    if (decision.annotation.outcome === 'applied') {
      lastWriterByTarget.set(targetKey(decision.annotation.target), index);
    }
  });

  for (const [index, decision] of decisions.entries()) {
    const outcome = decision.annotation.outcome;
    const superseded = outcome === 'applied'
      && lastWriterByTarget.get(targetKey(decision.annotation.target)) !== index;
    if (outcome === 'skipped-already-set' || outcome === 'skipped-provider-owned') {
      skipped += 1;
    } else if (outcome === 'applied') {
      if (superseded) {
        // Overwritten within this same row by a later column mapped to the same
        // target: exactly one datum landed, so exactly one is counted applied.
        skipped += 1;
      } else if (decision.fieldWrite) {
        // The database's compare-before-write can still decline an UPDATE that
        // would change nothing — a concurrent writer got there first. Counted as
        // skipped rather than applied so the totals describe what happened.
        if (changed.has(decision.fieldWrite.fieldKey)) applied += 1;
        else skipped += 1;
      } else if (written.warranty === 'applied') {
        applied += 1;
      } else {
        skipped += 1;
      }
    } else {
      // no-definition / type-error / not-applicable-to-device. `device-unresolved`
      // cannot reach here — the row would not have a target.
      failed += 1;
    }
  }

  return {
    index,
    deviceId: target.deviceId,
    organizationId: target.orgId,
    method: target.method,
    externalSystem: row.externalSystem?.trim() || null,
    applied,
    skipped,
    failed,
    appliedFieldKeys: written.changedFieldKeys,
    warranty: written.warranty,
    linkCreated: written.linkCreated,
  };
}

export async function commitDeviceCustomFieldImport(
  rows: readonly CommitValueRowInput[],
  ctx: ValueImportContext,
  actor: ValueImportActor,
  options: { mode?: ValueImportMode } = {},
): Promise<ValueImportSummary> {
  const effectiveCtx: ValueImportContext = { ...ctx, mode: options.mode ?? ctx.mode };
  // Re-derived against state loaded NOW, never against whatever preview saw.
  const derived = await deriveRows(rows, effectiveCtx);

  const summary: ValueImportSummary = {
    appliedValues: 0,
    skippedValues: 0,
    failedValues: 0,
    rows: [],
    linksCreated: 0,
    errors: [],
  };

  for (let index = 0; index < derived.length; index += 1) {
    const { resolved, decisions } = derived[index]!;
    const row = rows[index]!;

    const refusal = REFUSED_OUTCOMES[resolved.resolution.outcome];
    if (refusal) {
      summary.errors.push({
        index,
        error: REFUSAL_COPY[resolved.resolution.outcome] ?? 'This row cannot be imported',
        code: refusal,
      });
      continue;
    }

    const problem = checkExpectation(row, resolved);
    if (problem) {
      summary.errors.push({ index, ...problem });
      continue;
    }

    if (!resolved.target) {
      // Unreachable: every non-refused, expectation-clean outcome establishes a
      // target. Fails closed rather than asserting non-null.
      summary.errors.push({
        index,
        error: 'This row did not resolve to a single device — re-run preview',
        code: 'match-unconfirmed',
      });
      continue;
    }

    try {
      const written = await writeRow(row, resolved.target, decisions, effectiveCtx, actor);
      const result = tallyRow(index, row, resolved.target, decisions, written);
      // Pushed only after the write resolved, so a throw can never leave a row
      // in both `rows` and `errors`.
      summary.rows.push(result);
      summary.appliedValues += result.applied;
      summary.skippedValues += result.skipped;
      summary.failedValues += result.failed;
      if (result.linkCreated) summary.linksCreated += 1;
    } catch (err) {
      const node = pgErrorNode(err);
      const constraint = typeof node?.constraint_name === 'string'
        ? node.constraint_name
        : typeof node?.constraint === 'string'
          ? node.constraint
          : undefined;
      console.error('[custom-field-value-import] row failed', {
        partnerId: ctx.partnerId,
        index,
        deviceId: resolved.target.deviceId,
        actorUserId: actor.userId,
        code: pgErrorCode(err),
        ...(constraint ? { constraint } : {}),
        error: err instanceof Error ? err.message : String(err),
      });
      // A console line alone is only visible to whoever is grepping. An
      // UNRECOGNISED sqlstate (or a plain JS error from a future refactor) is a
      // code-level regression that would hit every row in the batch while the
      // operator reads "check the server log" on all of them — page it.
      // Recognised, expected refusals stay log-only so a bad CSV cannot flood
      // Sentry.
      if (!pgErrorCode(err) || !WRITE_FAILURE_COPY[pgErrorCode(err)!]) captureException(err);
      summary.errors.push(withCause({ index, ...writeFailure(err) }, err));
    }
  }

  return summary;
}
