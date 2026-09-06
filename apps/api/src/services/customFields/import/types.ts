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
 */
export interface DeviceCustomFieldImportValue {
  fieldKey: string;
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
