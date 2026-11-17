/**
 * DR plan group step types (`restoreConfig.commandType`), shared by the plan
 * editor (web) and the execution dispatcher (API) so the two cannot drift (#11856).
 *
 * Canonical values are what dispatch accepts: the device command types are
 * lower-case (`CommandTypes` on the API) and the non-command bare-metal rebuild
 * step keeps its historical upper-case spelling. Plans saved by an earlier
 * editor hold upper-case spellings (`VM_RESTORE_FROM_BACKUP`, ...), so every
 * reader runs the stored value through {@link normalizeDrStepType} instead of
 * comparing it directly. Leaf module, no imports.
 */
export const DR_STEP_TYPES = [
  'vm_restore_from_backup',
  'vm_instant_boot',
  'hyperv_restore',
  'mssql_restore',
  'bmr_recover',
  'BARE_METAL_REBUILD',
] as const;

export type DrStepType = (typeof DR_STEP_TYPES)[number];

/** The non-command step: dispatch creates recovery rows instead of a device command. */
export const DR_STEP_BARE_METAL_REBUILD = 'BARE_METAL_REBUILD' satisfies DrStepType;

const CANONICAL_BY_FOLDED: ReadonlyMap<string, DrStepType> = new Map(
  DR_STEP_TYPES.map((type) => [type.toLowerCase(), type] as const),
);

/**
 * Maps a stored or submitted step type to its canonical spelling, ignoring
 * case and surrounding whitespace. Returns null for anything that is not a DR
 * step type (including non-strings).
 */
export function normalizeDrStepType(value: unknown): DrStepType | null {
  if (typeof value !== 'string') return null;
  return CANONICAL_BY_FOLDED.get(value.trim().toLowerCase()) ?? null;
}

export function isDrStepType(value: unknown): value is DrStepType {
  return typeof value === 'string' && (DR_STEP_TYPES as readonly string[]).includes(value);
}
