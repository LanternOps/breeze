/**
 * Normalisation + admission rules for agent-reported patch metadata.
 *
 * `patches` is a deliberately GLOBAL, unscoped catalog table deduped on
 * `(source, external_id)` — every tenant reads the same row, and
 * `patch_approvals` / patch jobs hang off `patches.id`. Agent scan ingest is the
 * only high-volume writer to it, so anything it puts in an identity-bearing
 * column (`external_id`, `package_id`, `title`, `vendor`, `version`) is
 * effectively shared state. Two consequences drive this module:
 *
 * 1. `package_id` and `external_id` are command-bearing, not decorative. The Go
 *    agent resolves *which package to install* from them
 *    (`resolvePatchInstallID` / `patchLocalID` in
 *    `agent/internal/heartbeat/heartbeat.go`), and
 *    `routes/devices/patches.ts` forwards `patches.package_id` verbatim into the
 *    `install_patches` command payload. They must therefore be structurally
 *    sane before they are allowed to create or update a shared row.
 * 2. The column widths in `db/schema/patches.ts` are not enforced by the zod
 *    request schemas, so an over-length value currently reaches Postgres and
 *    raises `22001 value too long`, which aborts the whole scan transaction —
 *    one malformed row takes down the entire submit for that device.
 *
 * The admission rules are deliberately narrow so no existing provider breaks:
 * spaces stay legal (Apple `softwareupdate` labels such as
 * `macOS Sonoma 14.5-23F79` are used verbatim as both externalId and packageId),
 * and only control characters, option-like leading dashes and over-length
 * identifiers are refused.
 */

/** Column widths from `apps/api/src/db/schema/patches.ts`. */
export const PATCH_COLUMN_LIMITS = {
  externalId: 255,
  packageId: 256,
  title: 500,
  version: 64,
  vendor: 255,
  category: 100,
} as const;

/**
 * `description` is an unbounded `text` column, so this is a policy cap rather
 * than a schema limit: it bounds how much agent-supplied prose one shared row
 * can carry when up to 5000 patches arrive per request.
 */
export const PATCH_DESCRIPTION_LIMIT = 8000;

/** C0 controls + DEL. Never legitimate in an identifier; the injection-relevant class. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type PatchIdentityInput = {
  source: string;
  name: string;
  externalId?: string | undefined;
  kbNumber?: string | undefined;
  packageId?: string | undefined;
  version?: string | undefined;
  vendor?: string | undefined;
  category?: string | undefined;
  description?: string | undefined;
};

export type NormalizedPatchIdentity = {
  externalId: string;
  packageId: string | null;
  title: string;
  version: string | null;
  vendor: string | null;
  category: string | null;
  description: string | null;
};

export type PatchIdentityRejectionReason =
  | 'empty_title'
  | 'empty_external_id'
  | 'external_id_control_chars'
  | 'external_id_option_like'
  | 'external_id_too_long'
  | 'package_id_control_chars'
  | 'package_id_option_like'
  | 'package_id_too_long';

export type PatchIdentityResult =
  | { ok: true; value: NormalizedPatchIdentity }
  | { ok: false; reason: PatchIdentityRejectionReason };

function trimToNull(value: string | undefined | null): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function truncate(value: string | null, limit: number): string | null {
  if (value === null) return null;
  return value.length > limit ? value.slice(0, limit) : value;
}

function nullIfTooLong(value: string | null, limit: number): string | null {
  if (value === null) return null;
  return value.length > limit ? null : value;
}

/**
 * An identifier that starts with `-` would be read as a flag by every package
 * manager the agent shells out to (winget/choco/apt/yum/brew are invoked with
 * an argv, so shell metacharacters are inert, but option injection is not).
 *
 * Checked per colon-separated segment, not just on the whole string: the agent
 * splits provider-prefixed ids (`patchLocalID` / `splitPatchID` in
 * `agent/internal/heartbeat/heartbeat.go`) and installs the *local* part, so
 * `apple-softwareupdate:--all` passes a naive leading-dash test and still yields
 * `--all` as the package to install.
 */
function isOptionLike(value: string): boolean {
  return value.split(':').some((segment) => segment.startsWith('-'));
}

/**
 * Derive the dedup key exactly as the ingest route always has: explicit
 * `externalId`, else the KB number, else a composed `source:name:version`.
 * Kept here so the admission checks below apply to the value that actually
 * reaches the `(source, external_id)` conflict target.
 */
export function derivePatchExternalId(input: PatchIdentityInput): string {
  return (
    trimToNull(input.externalId) ??
    trimToNull(input.kbNumber) ??
    `${input.source}:${input.name.trim()}:${trimToNull(input.version) ?? 'latest'}`
  );
}

/**
 * Validate + normalise one agent-reported patch.
 *
 * Returns `ok: false` for a row that must not be admitted at all; the caller
 * skips it and counts it rather than failing the batch, so one malformed entry
 * cannot stop a device's whole patch scan from landing.
 */
export function normalizePatchIdentity(input: PatchIdentityInput): PatchIdentityResult {
  const title = trimToNull(input.name);
  if (title === null) {
    return { ok: false, reason: 'empty_title' };
  }

  const externalId = derivePatchExternalId(input);
  if (externalId === '') {
    return { ok: false, reason: 'empty_external_id' };
  }
  if (CONTROL_CHARS.test(externalId)) {
    return { ok: false, reason: 'external_id_control_chars' };
  }
  if (isOptionLike(externalId)) {
    return { ok: false, reason: 'external_id_option_like' };
  }
  // Truncating instead would silently merge two distinct patches that share a
  // 255-character prefix into one shared row, so an over-long key is refused.
  if (externalId.length > PATCH_COLUMN_LIMITS.externalId) {
    return { ok: false, reason: 'external_id_too_long' };
  }

  const packageId = trimToNull(input.packageId);
  if (packageId !== null) {
    if (CONTROL_CHARS.test(packageId)) {
      return { ok: false, reason: 'package_id_control_chars' };
    }
    if (isOptionLike(packageId)) {
      return { ok: false, reason: 'package_id_option_like' };
    }
    // Same reasoning as externalId: package_id selects what gets installed, so
    // a truncated one is worse than none.
    if (packageId.length > PATCH_COLUMN_LIMITS.packageId) {
      return { ok: false, reason: 'package_id_too_long' };
    }
  }

  return {
    ok: true,
    value: {
      externalId,
      packageId,
      // `title`/`vendor`/`description` are matching or display surfaces where a
      // truncated value is still better than losing the row.
      title: truncate(title, PATCH_COLUMN_LIMITS.title) as string,
      vendor: truncate(trimToNull(input.vendor), PATCH_COLUMN_LIMITS.vendor),
      description: truncate(trimToNull(input.description), PATCH_DESCRIPTION_LIMIT),
      // `version` and `category` are decision inputs — version drives the app
      // pin comparison and category selects (terminal) ring category rules in
      // `patchApprovalEvaluator`. A truncated value would silently compare or
      // match as something it isn't, so an over-length one is dropped to NULL
      // (no pin match, no category rule) instead.
      version: nullIfTooLong(trimToNull(input.version), PATCH_COLUMN_LIMITS.version),
      category: nullIfTooLong(trimToNull(input.category), PATCH_COLUMN_LIMITS.category),
    },
  };
}

export type AdmittedPatch<T> = { data: T; identity: NormalizedPatchIdentity };

export type PatchAdmission<T> = {
  admitted: AdmittedPatch<T>[];
  rejected: number;
  /** Bounded histogram of why rows were refused, for the audit trail. */
  reasons: Partial<Record<PatchIdentityRejectionReason, number>>;
};

/**
 * Admit a whole reported batch up front.
 *
 * Deliberately run BEFORE the tombstone sweep: the sweep marks a device's
 * existing pending rows `missing` on the assumption that everything still
 * applicable is about to be re-upserted. A row refused mid-loop would be swept
 * but never re-reported, tombstoning a patch that is in fact still pending — so
 * the caller needs the rejection count before it decides to sweep.
 */
export function admitPatchBatch<T extends PatchIdentityInput>(patchList: T[]): PatchAdmission<T> {
  const admitted: AdmittedPatch<T>[] = [];
  const reasons: Partial<Record<PatchIdentityRejectionReason, number>> = {};
  let rejected = 0;

  for (const data of patchList) {
    const result = normalizePatchIdentity(data);
    if (!result.ok) {
      rejected++;
      reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
      continue;
    }
    admitted.push({ data, identity: result.value });
  }

  return { admitted, rejected, reasons };
}

/**
 * Combine two rejection histograms by SUMMING per reason. Object spread would
 * silently drop the first side's count whenever both batches refused rows for
 * the same reason, which is the common case (the pending and installed lists of
 * one combined scan usually fail the same way).
 */
export function mergeRejectionReasons(
  a: Partial<Record<PatchIdentityRejectionReason, number>>,
  b: Partial<Record<PatchIdentityRejectionReason, number>>,
): Partial<Record<PatchIdentityRejectionReason, number>> {
  const merged: Partial<Record<PatchIdentityRejectionReason, number>> = { ...a };
  for (const [reason, count] of Object.entries(b) as [PatchIdentityRejectionReason, number][]) {
    merged[reason] = (merged[reason] ?? 0) + count;
  }
  return merged;
}
