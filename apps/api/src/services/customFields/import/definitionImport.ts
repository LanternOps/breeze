/**
 * Custom-field DEFINITION import pipeline: preview -> commit (#3257 W07).
 *
 * Named `customFieldDefinitionImport`, never `customFieldImport`: `tickets.
 * custom_fields` (`db/schema/portal.ts`) and the PSA/Jira `customFields`
 * (`services/psa/jira.ts`) are unrelated namesakes already in the tree, and the
 * VALUES importer (W08) is a different pipeline with different tenancy.
 *
 * Modelled on `services/contacts/import.ts`: preview annotates every row
 * against a snapshot; commit RE-DERIVES every annotation against freshly loaded
 * state and refuses any row whose annotation moved, with identity pinning on
 * the matched definition. Preview is advisory; the database is authority.
 *
 * ── What the annotations encode ─────────────────────────────────────────────
 * The destination was hardened before this importer shipped, and preview must
 * report that reality rather than a guess:
 *
 *  - W02 gave `custom_field_definitions` a per-axis unique index, so a
 *    same-axis re-import is `already-exists` (skipped), not a second row.
 *  - W02's `custom_field_definitions_one_owner_chk` makes ownership org XOR
 *    partner, so `ownerScope` is the row's whole ownership story.
 *  - W03's `custom_field_definitions_no_shadow` trigger forbids the same
 *    `field_key` on both axes under one partner, so a cross-axis collision is
 *    `key-shadowed` at preview instead of a P0001 nobody expected at commit.
 *
 * ── Where the snapshot comes from, and why it is a system read ──────────────
 * `custom_field_definitions` has NO partner-wide SELECT branch on its RLS
 * policy — it is listed in `PARTNER_WIDE_SELECT_BRANCH_EXEMPT`
 * (`rls-coverage.integration.test.ts`, TODO #4944) — so an ORGANIZATION-scoped
 * request context cannot see partner-wide rows at all. Reading the snapshot in
 * the request context would therefore annotate a shadowed key as `create` for
 * exactly the callers most likely to hit it. The snapshot is loaded in ONE
 * system context instead, bounded by `ctx.partnerId` AND `ctx.accessibleOrgIds`
 * — the same reasoning, and the same bound, as `contacts/import.ts:229`.
 *
 * Because that read has no RLS backstop, the app-layer bound is the WHOLE
 * boundary on it: a row naming an organization absent from the snapshot is
 * refused as `org-not-found`, the same annotation an unreachable org gets, so
 * the response is never an existence oracle.
 *
 * ── Where the WRITES happen, and why that is different ──────────────────────
 * Writes deliberately do NOT escape to a system context. Each row's insert runs
 * in a NESTED `db.transaction` inside the request's own `withDbAccessContext`
 * transaction, which drizzle emits as a SAVEPOINT
 * (`dbSavepointErrorIsolation.integration.test.ts` is the proof). That buys the
 * per-row failure isolation an importer needs — a failed statement would
 * otherwise abort the request transaction and every later row would raise
 * 25P02 — while keeping RLS as a real second control on every write. The
 * failing statement MUST be issued on the nested callback's `tx`, never on the
 * ambient `db` proxy, or the error is recorded against the OUTER scope and the
 * isolation is lost.
 */

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { customFieldDefinitions, organizations } from '../../../db/schema';
import { pgErrorCode, pgErrorNode } from '../../../utils/pgErrors';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../partnerWideAccess';
import { customFieldWriteConflict } from '../writeErrors';
import type {
  AnnotatedDefinitionRow,
  CommitDefinitionRowInput,
  CustomFieldDefinitionImportRow,
  CustomFieldType,
  DefinitionAnnotation,
  DefinitionImportErrorCode,
  DefinitionImportErrorEntry,
  DefinitionImportSummary,
} from './types';

export type * from './types';
export { MAX_IMPORT_ROWS, MAX_IMPORT_VALUES } from './types';

/** What the importer is allowed to see and do, resolved once at the route. */
export interface DefinitionImportContext {
  partnerId: string;
  /**
   * The caller's own organization allowlist. `null` is system scope
   * (unrestricted within the partner); an EMPTY array is a caller who can reach
   * no organization and must resolve to zero, never degrade into "no filter".
   */
  accessibleOrgIds: string[] | null;
  /**
   * From `canManagePartnerWidePolicies(auth)`. A partner-wide row from a caller
   * without it is refused at PREVIEW, not just at commit, and with its own
   * annotation — see `DefinitionAnnotation`.
   */
  canManagePartnerWide: boolean;
}

export interface DefinitionImportActor {
  userId: string | null;
}

interface SnapshotDefinition {
  id: string;
  fieldKey: string;
  type: CustomFieldType;
}

interface Snapshot {
  /** Organizations under this partner the caller can actually reach. */
  orgIds: Set<string>;
  /** `field_key` -> the partner-wide definition owning it. */
  partnerByKey: Map<string, SnapshotDefinition>;
  /** `orgId \0 field_key` -> the org-owned definition owning it. */
  orgByKey: Map<string, SnapshotDefinition>;
  /** `field_key` -> one org-owned definition using it, for shadow reporting. */
  anyOrgByKey: Map<string, SnapshotDefinition>;
}

// NUL separator: Postgres text cannot contain NUL, so composite keys built from
// user data can never collide across their parts.
const SEP = "\u0000";

async function loadSnapshot(ctx: DefinitionImportContext): Promise<Snapshot> {
  const snapshot: Snapshot = {
    orgIds: new Set(),
    partnerByKey: new Map(),
    orgByKey: new Map(),
    anyOrgByKey: new Map(),
  };

  const reach = ctx.accessibleOrgIds ?? null;
  // An empty reach is a caller who can reach nothing. They may still own
  // partner-wide rows, so the definition query still runs — but no organization
  // resolves, so every `ownerScope: 'organization'` row is `org-not-found`.

  // ONE escalation for both queries: two would acquire two pooled connections
  // under the request's own transaction rather than one.
  const { orgRows, definitionRows } = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const orgs = reach !== null && reach.length === 0
        ? []
        : ((await db
            .select({ id: organizations.id })
            .from(organizations)
            .where(
              and(
                eq(organizations.partnerId, ctx.partnerId),
                isNull(organizations.deletedAt),
                ...(reach ? [inArray(organizations.id, reach)] : []),
              ),
            )) as Array<{ id: string }>);

      const orgIds = orgs.map((o) => o.id);
      const definitions = (await db
        .select({
          id: customFieldDefinitions.id,
          orgId: customFieldDefinitions.orgId,
          partnerId: customFieldDefinitions.partnerId,
          fieldKey: customFieldDefinitions.fieldKey,
          type: customFieldDefinitions.type,
        })
        .from(customFieldDefinitions)
        .where(
          orgIds.length > 0
            ? or(
                eq(customFieldDefinitions.partnerId, ctx.partnerId),
                inArray(customFieldDefinitions.orgId, orgIds),
              )
            : eq(customFieldDefinitions.partnerId, ctx.partnerId),
        )) as Array<{
          id: string;
          orgId: string | null;
          partnerId: string | null;
          fieldKey: string;
          type: CustomFieldType;
        }>;

      return { orgRows: orgs, definitionRows: definitions };
    }, 'customFieldDefinitionImport.snapshot'),
  );

  for (const org of orgRows) snapshot.orgIds.add(org.id);

  for (const def of definitionRows) {
    const entry: SnapshotDefinition = { id: def.id, fieldKey: def.fieldKey, type: def.type };
    if (def.orgId) {
      // A definition on an organization outside the caller's reach can only
      // arrive here if the partner branch of the query matched it, which it
      // cannot: org-owned rows have a NULL partner_id (W02's XOR check).
      if (!snapshot.orgIds.has(def.orgId)) continue;
      snapshot.orgByKey.set(def.orgId + SEP + def.fieldKey, entry);
      if (!snapshot.anyOrgByKey.has(def.fieldKey)) snapshot.anyOrgByKey.set(def.fieldKey, entry);
    } else if (def.partnerId) {
      snapshot.partnerByKey.set(def.fieldKey, entry);
    }
  }

  return snapshot;
}

const DUPLICATE_IN_BATCH_REASON =
  'This field key appears more than once in the submitted file — remove the duplicate row';

function shadowReason(key: string, shadowedBy: 'partner' | 'organization'): string {
  return shadowedBy === 'partner'
    ? `Field key "${key}" already exists as an all-organizations field for this partner`
    : `Field key "${key}" already exists as an organization-owned field under this partner`;
}

/**
 * Annotate every row in ONE ordered pass.
 *
 * Pure, and deliberately order-dependent within the batch: a key's FIRST
 * occurrence is annotated against the database, and every later occurrence is
 * annotated against what the earlier row would leave behind. Preview and commit
 * therefore derive identical annotations for an unchanged batch — the whole
 * point of `expectedAnnotation` — and the "the file contradicts itself" cases
 * (`type-conflict` on a same-axis repeat, `key-shadowed` on a cross-axis
 * repeat) are reported instead of arriving as a bare 23505 / P0001 at commit.
 */
function annotateRows(
  rows: readonly CustomFieldDefinitionImportRow[],
  snapshot: Snapshot,
  ctx: DefinitionImportContext,
): AnnotatedDefinitionRow[] {
  /** Axis keys this batch will have written by the time a later row is reached. */
  const batchPartnerKeys = new Set<string>();
  const batchOrgKeys = new Set<string>();
  /** `field_key`s this batch claims on each axis, for cross-axis detection. */
  const batchPartnerFieldKeys = new Set<string>();
  const batchOrgFieldKeys = new Set<string>();

  return rows.map((row, index) => {
    const base = { ...row, index, existingId: null as string | null, existingType: null as CustomFieldType | null };
    const decide = (
      annotation: DefinitionAnnotation,
      extra: { existingId?: string | null; existingType?: CustomFieldType | null; conflictReason?: string } = {},
    ): AnnotatedDefinitionRow => ({ ...base, annotation, ...extra });

    if (row.ownerScope === 'partner') {
      if (!ctx.canManagePartnerWide) return decide('partner-wide-denied', { conflictReason: PARTNER_WIDE_WRITE_DENIED_MESSAGE });

      if (batchPartnerKeys.has(row.fieldKey)) return decide('type-conflict', { conflictReason: DUPLICATE_IN_BATCH_REASON });
      if (batchOrgFieldKeys.has(row.fieldKey)) {
        return decide('key-shadowed', { conflictReason: shadowReason(row.fieldKey, 'organization') });
      }

      const sameAxis = snapshot.partnerByKey.get(row.fieldKey);
      if (sameAxis) {
        batchPartnerKeys.add(row.fieldKey);
        batchPartnerFieldKeys.add(row.fieldKey);
        return sameAxis.type === row.type
          ? decide('already-exists', { existingId: sameAxis.id, existingType: sameAxis.type })
          : decide('type-conflict', {
              existingId: sameAxis.id,
              existingType: sameAxis.type,
              conflictReason:
                `Field key "${row.fieldKey}" already exists with type "${sameAxis.type}"; a field's type cannot be changed`,
            });
      }

      const shadowing = snapshot.anyOrgByKey.get(row.fieldKey);
      if (shadowing) {
        return decide('key-shadowed', {
          existingId: shadowing.id,
          existingType: shadowing.type,
          conflictReason: shadowReason(row.fieldKey, 'organization'),
        });
      }

      batchPartnerKeys.add(row.fieldKey);
      batchPartnerFieldKeys.add(row.fieldKey);
      return decide('create');
    }

    // ownerScope === 'organization'
    const orgId = row.organizationId;
    // "Not named", "does not exist" and "not yours" all collapse to one
    // annotation so the response is never an existence oracle.
    if (!orgId || !snapshot.orgIds.has(orgId)) return decide('org-not-found');

    const axisKey = orgId + SEP + row.fieldKey;
    if (batchOrgKeys.has(axisKey)) return decide('type-conflict', { conflictReason: DUPLICATE_IN_BATCH_REASON });
    if (batchPartnerFieldKeys.has(row.fieldKey)) {
      return decide('key-shadowed', { conflictReason: shadowReason(row.fieldKey, 'partner') });
    }

    const sameAxis = snapshot.orgByKey.get(axisKey);
    if (sameAxis) {
      batchOrgKeys.add(axisKey);
      batchOrgFieldKeys.add(row.fieldKey);
      return sameAxis.type === row.type
        ? decide('already-exists', { existingId: sameAxis.id, existingType: sameAxis.type })
        : decide('type-conflict', {
            existingId: sameAxis.id,
            existingType: sameAxis.type,
            conflictReason:
              `Field key "${row.fieldKey}" already exists with type "${sameAxis.type}"; a field's type cannot be changed`,
          });
    }

    const shadowing = snapshot.partnerByKey.get(row.fieldKey);
    if (shadowing) {
      return decide('key-shadowed', {
        existingId: shadowing.id,
        existingType: shadowing.type,
        conflictReason: shadowReason(row.fieldKey, 'partner'),
      });
    }

    batchOrgKeys.add(axisKey);
    batchOrgFieldKeys.add(row.fieldKey);
    return decide('create');
  });
}

export async function previewCustomFieldDefinitionImport(
  rows: readonly CustomFieldDefinitionImportRow[],
  ctx: DefinitionImportContext,
): Promise<AnnotatedDefinitionRow[]> {
  return annotateRows(rows, await loadSnapshot(ctx), ctx);
}

interface ExpectationProblem {
  error: string;
  code: DefinitionImportErrorCode;
}

/**
 * Validate a commit row's re-derived annotation against the client's
 * acknowledgement. The annotation guard runs first, then identity pinning.
 *
 * The identity pin is what stops a `create` from silently becoming a no-op and
 * an `already-exists` acknowledgement from being transferred: an operator who
 * approved "reuse definition X" must not have that approval applied to whatever
 * definition took over the key since preview.
 */
function checkExpectation(
  row: CommitDefinitionRowInput,
  derived: DefinitionAnnotation,
  existingId: string | null,
): ExpectationProblem | null {
  if (row.expectedAnnotation && row.expectedAnnotation !== derived) {
    return {
      code: 'annotation-changed',
      error: `Annotation changed since preview: expected "${row.expectedAnnotation}", now "${derived}" — re-run preview`,
    };
  }
  if (row.expectedDefinitionId && (derived !== 'already-exists' || existingId !== row.expectedDefinitionId)) {
    return {
      code: 'match-changed',
      error: 'Match changed since preview: the row now resolves to a different custom field — re-run preview',
    };
  }
  if (derived === 'already-exists' && row.expectedAnnotation === 'already-exists' && !row.expectedDefinitionId) {
    // The wire schema requires the pin, so this is unreachable from the routes.
    // It is here because the service is also reachable directly, and an
    // unpinned acknowledgement is exactly the transfer the pin exists to refuse.
    return {
      code: 'match-changed',
      error: 'An "already-exists" acknowledgement must also carry expectedDefinitionId naming that custom field',
    };
  }
  return null;
}

/**
 * Attach the original thrown error WITHOUT making it serializable: routes hand
 * the summary straight to `c.json(...)`, and a stack trace (or a pg error
 * carrying query text) must never reach a response body. Read `entry.cause`
 * in-process; never serialize it.
 */
function withCause(entry: DefinitionImportErrorEntry, cause: unknown): DefinitionImportErrorEntry {
  Object.defineProperty(entry, 'cause', { value: cause, enumerable: false, writable: false });
  return entry;
}

/**
 * Stable, non-leaking copy for a failed row.
 *
 * A postgres.js error's `.message` carries the failing statement's detail —
 * column values, constraint text, sometimes the query itself — so it is
 * customer data and schema disclosure in one string and must never reach the
 * response body. Known SQLSTATEs get useful fixed copy; anything else, pg or
 * not, collapses to the generic line.
 */
const WRITE_FAILURE_COPY: Record<string, string> = {
  '23503': 'The organization this custom field refers to no longer exists',
  '23514': 'A custom field must be owned by exactly one of an organization or the partner',
  '22001': 'A value on this row is too long for the field it targets',
  '42501': 'You do not have access to create a custom field for this owner',
};
const GENERIC_WRITE_FAILURE = 'Could not write this custom field — check the server log for details';

function writeFailure(err: unknown, fieldKey: string): ExpectationProblem {
  // The two conflicts W02/W03 can raise share ONE mapper with the single-create
  // route (services/customFields/writeErrors.ts) so the copy cannot drift.
  const conflict = customFieldWriteConflict(err, fieldKey);
  if (conflict) {
    return {
      error: conflict.error,
      // A cross-axis shadow is a distinct, fixable operator problem, so it keeps
      // its own row code. A same-axis duplicate reaching the WRITE is a race
      // that preview did not see, which is a write failure, not a file problem.
      code: conflict.code === 'field-key-shadowed' ? 'key-shadowed' : 'write-failed',
    };
  }
  const code = pgErrorCode(err);
  return { error: (code && WRITE_FAILURE_COPY[code]) ?? GENERIC_WRITE_FAILURE, code: 'write-failed' };
}

/** Annotations that can never be acknowledged into a write. */
const REFUSED_ANNOTATIONS: Record<string, DefinitionImportErrorCode> = {
  'partner-wide-denied': 'partner-wide-denied',
  'org-not-found': 'org-not-found',
  'type-conflict': 'type-conflict',
  'key-shadowed': 'key-shadowed',
};

const REFUSAL_COPY: Record<string, string> = {
  'partner-wide-denied': PARTNER_WIDE_WRITE_DENIED_MESSAGE,
  'org-not-found': 'That organization was not found',
  'type-conflict': 'This custom field conflicts with one that already exists',
  'key-shadowed': 'This custom field key is already in use on the other ownership axis',
};

export async function commitCustomFieldDefinitionImport(
  rows: readonly CommitDefinitionRowInput[],
  ctx: DefinitionImportContext,
  actor: DefinitionImportActor,
): Promise<DefinitionImportSummary> {
  // Re-derived against state loaded NOW, not against whatever preview saw.
  const annotated = annotateRows(rows, await loadSnapshot(ctx), ctx);
  const summary: DefinitionImportSummary = { created: [], skipped: [], errors: [] };

  for (const derived of annotated) {
    const row = rows[derived.index] as CommitDefinitionRowInput;
    const refusal = REFUSED_ANNOTATIONS[derived.annotation];
    if (refusal) {
      summary.errors.push({
        index: derived.index,
        fieldKey: row.fieldKey,
        error: derived.conflictReason ?? REFUSAL_COPY[derived.annotation] ?? 'This row cannot be imported',
        code: refusal,
      });
      continue;
    }

    const problem = checkExpectation(row, derived.annotation, derived.existingId);
    if (problem) {
      summary.errors.push({ index: derived.index, fieldKey: row.fieldKey, ...problem });
      continue;
    }

    if (derived.annotation === 'already-exists') {
      // The definition already says what this row says. Re-importing an
      // unchanged file writes nothing at all, and never rewrites a field a tech
      // may have edited since.
      summary.skipped.push({
        index: derived.index,
        definitionId: derived.existingId!,
        fieldKey: row.fieldKey,
        reason: 'already-exists',
      });
      continue;
    }

    const orgId = row.ownerScope === 'organization' ? row.organizationId! : null;
    const partnerId = row.ownerScope === 'partner' ? ctx.partnerId : null;

    try {
      // Nested transaction => SAVEPOINT: a refused row rolls back to its own
      // savepoint and leaves the request transaction healthy for the next one.
      // The statement MUST be issued on `tx`, never the ambient `db` proxy.
      const inserted = (await db.transaction(async (tx) =>
        tx
          .insert(customFieldDefinitions)
          .values({
            orgId,
            partnerId,
            name: row.name,
            fieldKey: row.fieldKey,
            type: row.type,
            options: row.options ?? null,
            required: row.required ?? false,
            deviceTypes: row.deviceTypes ?? null,
          })
          .returning(),
      )) as Array<{ id: string }>;

      const created = inserted[0];
      if (!created) throw new Error('insert returned no row');

      // Reported only after the write has resolved, so a throw can never leave
      // a row in `created` AND `errors` both.
      summary.created.push({
        index: derived.index,
        definitionId: created.id,
        fieldKey: row.fieldKey,
        ownerScope: row.ownerScope,
        organizationId: orgId,
      });
    } catch (err) {
      const node = pgErrorNode(err);
      const constraint = typeof node?.constraint_name === 'string'
        ? node.constraint_name
        : typeof node?.constraint === 'string'
          ? node.constraint
          : undefined;
      console.error('[custom-field-definition-import] row failed', {
        partnerId: ctx.partnerId,
        index: derived.index,
        actorUserId: actor.userId,
        code: pgErrorCode(err),
        ...(constraint ? { constraint } : {}),
        error: err instanceof Error ? err.message : String(err),
      });
      summary.errors.push(
        withCause({ index: derived.index, fieldKey: row.fieldKey, ...writeFailure(err, row.fieldKey) }, err),
      );
    }
  }

  return summary;
}
