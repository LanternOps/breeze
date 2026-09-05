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

export interface DeviceResolution {
  outcome: DeviceRowOutcome;
  deviceId: string | null;
  method: DeviceMatchMethod | null;
  /** Populated for `ambiguous` and `identity-conflict`; ordered by the presentational ranking. */
  candidates: DeviceCandidate[];
  /** Populated for `identity-conflict`: which identifiers disagreed, in precedence order. */
  conflictingMethods?: DeviceMatchMethod[];
}

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
