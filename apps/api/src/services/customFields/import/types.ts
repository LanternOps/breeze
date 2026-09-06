/**
 * Wire types for the RMM custom-field importer (#3257).
 *
 * DEPENDENCY-FREE ON PURPOSE. This module imports nothing — not the db, not a
 * service, not a schema — so W07's definition importer and W08's value importer
 * can both depend on it without an import cycle. Everything here is either a
 * type (erased at compile time) or a frozen literal list. Never add a runtime
 * import to this file; put the code in the service module that needs it.
 *
 * Created in W06 and extended by W07/W08 — the row and outcome vocabulary is
 * shared across every stage of the pipeline.
 */

/** The system a row was exported from. Free-form on the wire; this is the set the UI offers. */
export const IMPORT_SYSTEMS = ['datto_rmm', 'ninjaone', 'cw_automate', 'n_central', 'csv'] as const;
export type ImportSystem = (typeof IMPORT_SYSTEMS)[number];

/**
 * The system recorded for a link when a row supplies an external id but no
 * system — a hand-rolled CSV, which is the common case for the long tail of
 * incumbents this feature does not name.
 */
export const DEFAULT_IMPORT_SYSTEM: ImportSystem = 'csv';

/** Which identifier produced a match. Ordered by the resolver's precedence. */
export type DeviceMatchMethod = 'id' | 'link' | 'serial' | 'hostname';

export type DeviceRowOutcome =
  | 'matched'
  | 'link-match'
  | 'ambiguous'
  | 'not-found'
  | 'org-not-found'
  | 'identity-conflict';

/**
 * A device the operator may be shown when a row cannot be resolved on its own.
 * Carries enough evidence — serial, OS, enrolment date, last-seen — that the
 * pick is made on facts rather than on the order the list happens to be in.
 */
export interface DeviceCandidate {
  deviceId: string;
  hostname: string | null;
  displayName: string | null;
  serialNumber: string | null;
  osType: string | null;
  status: string | null;
  enrolledAt: string | null;
  lastSeenAt: string | null;
  siteId: string | null;
  /** Which identifier produced this candidate. Presentational. */
  method: DeviceMatchMethod;
}

/**
 * Discriminated on `outcome` so the pairing rules are the TYPE, not a comment:
 * only a resolved row can carry a `deviceId`, and only an `identity-conflict`
 * carries `conflictingMethods`. W07/W08/W09 construct and consume these, and a
 * flat record would let any of them mint `{ outcome: 'ambiguous', deviceId }` —
 * exactly the "silently picked one" failure this wave exists to prevent.
 *
 * Still plain JSON: every arm is literals, strings, nulls and arrays, so it
 * round-trips through the HTTP boundary identically to a flat interface.
 *
 * `candidates` is ordered by the presentational ranking and is empty on every
 * arm but `ambiguous` and `identity-conflict`.
 */
interface DeviceResolutionEvidence {
  /**
   * Identifiers the row DID supply that carried no information — today only
   * `serial`, when the value is on the agent's junk denylist. Absent when
   * nothing was discarded.
   *
   * This exists because "no serial column" and "every serial in this export is
   * the BIOS filler string" both fail to match, and only the second is a
   * data-quality problem the operator can act on. Without it, a mis-mapped CSV
   * column is a wall of indistinguishable `not-found`s.
   */
  discardedIdentifiers?: DeviceMatchMethod[];
}

export type DeviceResolution = DeviceResolutionEvidence & (
  | {
      outcome: 'matched';
      deviceId: string;
      method: Exclude<DeviceMatchMethod, 'link'>;
      candidates: DeviceCandidate[];
      conflictingMethods?: never;
    }
  | {
      outcome: 'link-match';
      deviceId: string;
      method: 'link';
      candidates: DeviceCandidate[];
      conflictingMethods?: never;
    }
  | {
      outcome: 'ambiguous';
      deviceId: null;
      method: null;
      candidates: DeviceCandidate[];
      conflictingMethods?: never;
    }
  | {
      outcome: 'not-found' | 'org-not-found';
      deviceId: null;
      method: null;
      candidates: DeviceCandidate[];
      conflictingMethods?: never;
    }
  | {
      outcome: 'identity-conflict';
      deviceId: null;
      method: null;
      candidates: DeviceCandidate[];
      /** Which identifiers disagreed, in precedence order. Never empty. */
      conflictingMethods: DeviceMatchMethod[];
    }
);

/**
 * One value assignment on an import row. W08 owns the coercion and validation
 * rules; the resolver never reads this field, and only carries it so a row can
 * be passed through resolution and commit as one object.
 *
 * `target` (rather than the bare `fieldKey` this shipped with in W06) is what
 * lets one mapped CSV column land somewhere other than a custom field — see
 * `MappingTarget` in the W08 section below. W06 reserved the field's meaning
 * for W08 and no code outside these types ever read it.
 */
export interface DeviceCustomFieldImportValue {
  target: MappingTarget;
  value: unknown;
}

/**
 * One submitted row of the VALUES importer. Every identifier is optional and
 * every supplied one is resolved — see `resolveDeviceRow`, which refuses a row
 * whose identifiers disagree rather than letting the first hit win.
 */
export interface DeviceCustomFieldImportRow {
  /** Restricts resolution to one organization. Out of reach ⇒ `org-not-found`. */
  organizationId?: string | null;
  deviceId?: string | null;
  externalSystem?: string | null;
  externalId?: string | null;
  /** Reserved discriminator for the external-link key; always null today. */
  externalSourceInstance?: string | null;
  serialNumber?: string | null;
  hostname?: string | null;
  values: DeviceCustomFieldImportValue[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * W07 — definitions importer (#4775)
 *
 * The definitions pass has its own tenancy (dual-axis config: org XOR partner),
 * its own authorization (partner-wide rows need `canManagePartnerWidePolicies`)
 * and its own lifecycle, so it shares the module but none of the row shapes
 * above.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Same cap as the org and contact importers
 * (`services/contacts/types.ts:43`). One number across all four import routes
 * so the browser can chunk once and target every one of them.
 */
export const MAX_IMPORT_ROWS = 1000;

/**
 * A SEPARATE, lower ceiling on `sum(row.values.length)` for the VALUES importer
 * (W08). One device row carries up to 30 values, so 1000 rows x 30 values is
 * 30,000 writes in one request — a cap on rows alone does not bound the work.
 * Rejected at the zod layer with copy telling the browser to split the chunk.
 *
 * Declared here rather than in W08 because both caps are part of the same wire
 * contract the browser chunks against, and this module is the one place both
 * importers already share.
 */
export const MAX_IMPORT_VALUES = 5000;

/** Mirrors the `custom_field_type` Postgres enum (`db/schema/customFields.ts`). */
export type CustomFieldType = 'text' | 'number' | 'boolean' | 'dropdown' | 'date';

/**
 * The shared `CustomFieldOptions` contract
 * (`packages/shared/src/types/filters.ts`), which `routes/customFields.ts`
 * accepts on create. Restated structurally rather than imported so this module
 * stays dependency-free (see the header).
 *
 * `choices` accepts the bare-string form too, because rows already stored that
 * way exist and `routes/customFields.ts`'s `customFieldChoiceSchema` accepts
 * both — an importer that accepted only the object form would reject a file
 * exported from Breeze itself.
 */
export interface CustomFieldImportOptions {
  choices?: Array<string | { label: string; value: string }>;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  placeholder?: string;
}

/**
 * Which axis owns the definition, as a DISCRIMINATED UNION rather than a
 * `ownerScope` field plus an optional `organizationId` and a comment.
 *
 * `custom_field_definitions_one_owner_chk` (W02) makes ownership org XOR
 * partner at the database level, and the type says the same thing: an
 * `organization` row cannot be constructed without its `organizationId`, so
 * neither the commit path nor a future caller can reach the insert with a
 * missing one. Same reasoning as W06's `DeviceResolution` above, and the JSON
 * shape is unchanged — every arm is literals and strings.
 */
export type DefinitionOwner =
  | { ownerScope: 'organization'; organizationId: string }
  | { ownerScope: 'partner'; organizationId?: undefined };

/** One submitted row of the DEFINITIONS importer. */
export type CustomFieldDefinitionImportRow = DefinitionOwner & {
  fieldKey: string;
  name: string;
  type: CustomFieldType;
  options?: CustomFieldImportOptions | null;
  required?: boolean;
  deviceTypes?: Array<'windows' | 'macos' | 'linux'> | null;
  /**
   * The incumbent's own name for the field, e.g. `udf7`. Preserved in the audit
   * trail so a post-migration "where did this field come from" is answerable,
   * and deliberately NEVER stored on the definition row — there is no column
   * for it and inventing one would make the importer's provenance a permanent
   * part of the table's shape.
   */
  sourceLabel?: string;
};

/**
 * What preview says about a row, and what commit re-derives before writing it.
 *
 * - `create` — no definition owns this key on this row's axis.
 * - `already-exists` — same axis, same key, SAME type: a re-import of a file
 *   that already landed. Skipped, never rewritten.
 * - `type-conflict` — same axis, same key, DIFFERENT type; or the key appears
 *   more than once in the submitted batch. `type` is immutable on update
 *   (`updateCustomFieldSchema` omits it), so reconciling would mean
 *   delete-and-recreate, which orphans every value stored under the key.
 * - `key-shadowed` — the key exists on the OTHER axis under this partner. W03's
 *   `custom_field_definitions_no_shadow` trigger refuses the write (P0001); the
 *   importer says so at preview instead of letting it surface as a mystery.
 * - `org-not-found` — `ownerScope: 'organization'` naming an organization
 *   outside the caller's reach, or none at all. Deliberately the same
 *   annotation for "does not exist" and "not yours" so the response is never an
 *   existence oracle.
 * - `partner-wide-denied` — `ownerScope: 'partner'` from a caller without
 *   `canManagePartnerWidePolicies`. Its OWN annotation, never `org-not-found`:
 *   telling a tech "that organization does not exist" when the truth is "you
 *   may not create all-organizations fields" sends them to fix the wrong thing.
 */
export type DefinitionAnnotation =
  | 'create'
  | 'already-exists'
  | 'type-conflict'
  | 'key-shadowed'
  | 'org-not-found'
  | 'partner-wide-denied';

/**
 * Deliberately NOT discriminated on `annotation`, unlike `DeviceResolution`.
 * `existingId`/`existingType` do not correlate 1:1 with the annotation:
 * `type-conflict` arises both with an existing definition (same axis, different
 * type) and without one (the key appears twice in the submitted file). Modelling
 * that faithfully would mean inventing wire-visible annotation variants purely
 * to carry an internal batch-vs-database distinction, widening the vocabulary
 * every client's `expectedAnnotation` has to track. Every consumer gates on
 * `annotation` before reading these fields.
 */
export type AnnotatedDefinitionRow = CustomFieldDefinitionImportRow & {
  index: number;
  annotation: DefinitionAnnotation;
  /** The existing definition this row matched, for the preview UI. */
  existingId: string | null;
  existingType: CustomFieldType | null;
  conflictReason?: string;
};

export type CommitDefinitionRowInput = CustomFieldDefinitionImportRow & {
  /** Commit re-derives and refuses any row whose annotation moved. */
  expectedAnnotation?: DefinitionAnnotation;
  /**
   * Identity pin, required for `already-exists`. Not folded into the union with
   * `expectedAnnotation`: a row may legitimately carry NO acknowledgement at all
   * (a caller that never previewed), so a clean two-arm split does not exist.
   * Enforced at the wire by the route schema and again by `checkExpectation`.
   */
  expectedDefinitionId?: string;
};

export type DefinitionImportErrorCode =
  | 'org-not-found'
  | 'type-conflict'
  | 'key-shadowed'
  | 'annotation-changed'
  | 'match-changed'
  | 'partner-wide-denied'
  | 'write-failed';

export interface DefinitionImportCreatedEntry {
  index: number;
  definitionId: string;
  fieldKey: string;
  ownerScope: 'partner' | 'organization';
  organizationId: string | null;
}

export interface DefinitionImportSkippedEntry {
  index: number;
  definitionId: string;
  fieldKey: string;
  reason: 'already-exists';
}

export interface DefinitionImportErrorEntry {
  index: number;
  fieldKey: string;
  error: string;
  code: DefinitionImportErrorCode;
  /**
   * Attached NON-ENUMERABLY by the service so it never reaches a JSON body —
   * routes hand this summary straight to `c.json(...)` and a pg error carries
   * query text and column values. Read in-process; never serialize it.
   */
  cause?: unknown;
}

export interface DefinitionImportSummary {
  created: DefinitionImportCreatedEntry[];
  skipped: DefinitionImportSkippedEntry[];
  errors: DefinitionImportErrorEntry[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * W08 — values importer (#4776)
 *
 * The values pass is org-scoped and device-scoped: there is no ownership axis
 * to choose, but there IS a second destination. A migrating MSP's incumbent
 * export carries warranty expiry in the same file as its custom fields, and
 * landing that in a text custom field ships the flagship use case INERT (see
 * `warrantyTarget.ts`), so a mapped column names a TARGET, not a field key.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The `device_warranty` columns an import may write.
 *
 * `status` is deliberately absent: it is COMPUTED from the end date
 * (`computeWarrantyStatus`), never taken from the file. A CSV that could set
 * `status` directly would let a stale export mark an expired machine `active`
 * and silence its own alert. `is_subscription` is absent for the same reason
 * plus a stronger one — a true value suppresses expiry alerting outright
 * (`warrantyAlertEvaluator.ts:208`) and an import cannot know it.
 */
export type WarrantyImportField = 'warrantyStartDate' | 'warrantyEndDate' | 'manufacturer';

/**
 * Where one mapped column lands. A discriminated union rather than a nullable
 * `fieldKey` beside an optional `warrantyField`, so "a warranty column has no
 * field key" is carried by the TYPE — the same reasoning as `DeviceResolution`
 * above, and the reason no downstream caller needs a non-null assertion.
 */
export type MappingTarget =
  | { kind: 'customField'; fieldKey: string }
  | { kind: 'warranty'; field: WarrantyImportField };

/**
 * Row-level: how the DEVICE resolved. An ALIAS of W06's outcome vocabulary,
 * never a second copy — preview, commit and the wizard all branch on one set.
 */
export type ValueRowOutcome = DeviceRowOutcome;

/**
 * Per-VALUE: what happened to this one datum.
 *
 * PER VALUE, NOT PER ROW — the single most important shape decision in this
 * wave. One device row carries up to 30 mapped columns and the normal case is
 * mixed: 28 land, one names a field this organization has never defined, one
 * holds `abc` in a number column. A row-level annotation cannot express that,
 * and an all-or-nothing row would refuse a whole migration over one bad cell.
 *
 * - `applied` — written (or, at preview, would be written).
 * - `skipped-already-set` — a value is already stored for this target on this
 *   device, and writing would change nothing OR the mode is `skip`. Covers BOTH
 *   "the stored value is identical" (a re-import: a no-op in either mode) and
 *   "the stored value differs and the default `skip` mode declines to overwrite
 *   it" — one honest reason instead of two synonyms for "nothing to do here".
 * - `skipped-provider-owned` — WARRANTY only. A manufacturer API lookup
 *   (`data_source = 'provider'`) owns this device's warranty and the operator
 *   did not opt into overriding it. Its OWN member rather than
 *   `skipped-already-set`: "already correct, nothing to do" and "refused, and
 *   there is a switch you can flip" are different messages to show a tech, and
 *   a consumer branching on `outcome` must not have to parse a warning string
 *   to tell them apart. Mirrors `WarrantyImportOutcome` one layer up.
 * - `no-definition` — no `custom_field_definitions` row visible to this
 *   device's organization owns this key. Run the DEFINITIONS import (W07) first.
 * - `type-error` — `validateCustomFieldValue` refused it; `reason` says how.
 * - `not-applicable-to-device` — the definition is scoped to `deviceTypes` this
 *   device's OS is not in (the gate `validateValueMap` already applies).
 * - `device-unresolved` — the ROW did not resolve to exactly one device, so no
 *   value on it can be judged at all: there is no organization whose definitions
 *   to look the key up in. Without this member an ambiguous row's values would
 *   have to borrow an annotation that means something else.
 */
export type ValueOutcome =
  | 'applied'
  | 'skipped-already-set'
  | 'skipped-provider-owned'
  | 'no-definition'
  | 'type-error'
  | 'not-applicable-to-device'
  | 'device-unresolved';

/**
 * Why `validateCustomFieldValue` refused a value. Restated structurally rather
 * than imported so this module keeps its no-imports rule (see the file header).
 * `services/customFields/validateValue.ts` is the source of truth, and
 * `valueImport.ts` carries a compile-time assertion that the two agree — so a
 * new rejection reason there breaks the build rather than drifting silently.
 */
export type CustomFieldImportRejection =
  | 'invalid_type'
  | 'out_of_range'
  | 'not_a_choice'
  | 'too_long'
  | 'invalid_date';

/**
 * Advisory, and genuinely ORTHOGONAL to `outcome` — several outcomes can carry
 * one, so unlike `reason` it is not folded into an arm below. Today:
 *
 *  - on `applied`, the partner-integration identity keys (`asset_tag`,
 *    `inventory_id`, `external_id` and their camelCase spellings), which
 *    `routes/partnerApi/devices.ts` republishes as a device's
 *    `stableIdentifiers` to every integration the partner has connected.
 *    Writing them is intended; doing it fleet-wide without being told is not.
 *  - on `skipped-provider-owned`, how to override the refusal.
 */
interface ImportValueAdvice {
  target: MappingTarget;
  warning?: string;
}

/**
 * `reason` is DISCRIMINATED onto the one outcome that has it, rather than being
 * an optional field beside a comment — the same reasoning (and the same JSON
 * shape, since every arm is literals and strings) as `DeviceResolution` above.
 * A producer cannot mint `{ outcome: 'applied', reason: 'too_long' }`, and a
 * consumer cannot read `reason` without first narrowing to `type-error`.
 */
export type AnnotatedImportValue = ImportValueAdvice & (
  | { outcome: 'type-error'; reason: CustomFieldImportRejection }
  | {
      outcome: Exclude<ValueOutcome, 'type-error'>;
      reason?: never;
    }
);

export interface AnnotatedValueRow {
  index: number;
  outcome: ValueRowOutcome;
  deviceId: string | null;
  method: DeviceMatchMethod | null;
  organizationId: string | null;
  /** Ranked, for `ambiguous` / `identity-conflict`. The UI must require a pick. */
  candidates: DeviceCandidate[];
  conflictingMethods?: DeviceMatchMethod[];
  discardedIdentifiers?: DeviceMatchMethod[];
  values: AnnotatedImportValue[];
}

export interface CommitValueRowInput extends DeviceCustomFieldImportRow {
  /** Commit re-derives the row outcome and refuses any row whose outcome moved. */
  expectedOutcome?: ValueRowOutcome;
  /**
   * Identity pin. REQUIRED when `expectedOutcome` is `ambiguous`: an
   * acknowledgement that says "apply this" without saying "to WHOM" would
   * transfer to a different device if the candidate set moved between preview
   * and commit — the exact silent mis-assignment W06's resolver refuses to make
   * on its own.
   */
  expectedDeviceId?: string;
}

/**
 * Verbatim from the contacts importer (`ContactImportMode`), including the
 * default (`skip`). A third importer using the same word with the same default
 * is worth more than a marginally better one.
 */
export type ValueImportMode = 'skip' | 'update';

export type ValueImportErrorCode =
  | 'org-not-found'
  | 'not-found'
  | 'identity-conflict'
  | 'annotation-changed'
  | 'match-changed'
  | 'match-unconfirmed'
  | 'write-failed';

/**
 * What the row's warranty columns did, at ROW level.
 *
 * `none` means the file mapped no warranty column at all — never "it mapped one
 * and nothing came of it". `rejected` is that second case: a warranty column WAS
 * mapped and every mapped cell was refused (see the per-value outcomes for
 * which). Collapsing the two would tell an operator their warranty column was
 * never mapped when in fact it was read and thrown away.
 */
export type WarrantyImportOutcome =
  | 'applied'
  | 'skipped-provider-owned'
  | 'skipped-already-set'
  | 'rejected'
  | 'none';

export interface ValueImportRowResult {
  index: number;
  deviceId: string;
  organizationId: string;
  /**
   * How the device resolved, and which system the row came from. Both are
   * carried on the SUMMARY because the service has no Hono context and the
   * ROUTE writes the audits — "where did this asset tag come from" is only
   * answerable after a migration if the resolution method is recorded.
   */
  method: DeviceMatchMethod;
  externalSystem: string | null;
  applied: number;
  skipped: number;
  failed: number;
  /**
   * Field KEYS only, for the audit's `changedFields`. A VALUE can be anything
   * the incumbent held and must never enter an audit payload — the same rule
   * `scriptWriteBack.ts` and `customFieldValues.ts` already apply.
   */
  appliedFieldKeys: string[];
  warranty: WarrantyImportOutcome;
  linkCreated: boolean;
}

export interface ValueImportErrorEntry {
  index: number;
  error: string;
  code: ValueImportErrorCode;
  /**
   * Attached NON-ENUMERABLY by the service so it never reaches a JSON body —
   * routes hand this summary straight to `c.json(...)` and a pg error carries
   * query text and column values. Read in-process; never serialize it.
   */
  cause?: unknown;
}

export interface ValueImportSummary {
  /**
   * Counts VALUES, not rows. An operator cannot reconcile "30,000 in the file"
   * against "1,180 imported" otherwise — and a row count would hide the very
   * partial-application behaviour this importer is built around.
   *
   * MIND THE UNITS when totalling problems: `failedValues` counts values inside
   * rows that DID reach a device, while a row refused outright (resolution or a
   * stale acknowledgement) contributes nothing to it and appears only in
   * `errors[]`, in ROW units. The two are not addable without converting.
   */
  appliedValues: number;
  skippedValues: number;
  failedValues: number;
  rows: ValueImportRowResult[];
  linksCreated: number;
  errors: ValueImportErrorEntry[];
}
