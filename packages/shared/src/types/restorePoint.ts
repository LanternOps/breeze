/**
 * Windows System Restore checkpoint requests (#4609).
 *
 * The server stamps a versioned `restorePoint` block into the payload of
 * `install_patches`, `script` and `software_install` commands; the agent parses
 * it in agent/internal/systemrestore/request.go. The block records what was
 * requested -- never a promise that a checkpoint exists or can be restored.
 */

export const RESTORE_POINT_TRIGGERS = ['patch', 'script', 'software_install'] as const;
export type RestorePointTrigger = (typeof RESTORE_POINT_TRIGGERS)[number];

/**
 * 'requested' is server-only: written at command-creation time so an absent
 * ledger row means "Breeze never asked". Every other value is observed from the
 * agent. Mirrors RESTORE_POINT_ATTEMPT_STATUSES on the ledger schema.
 */
export const RESTORE_POINT_STATUSES = [
  'requested',
  'created',
  'existing_accepted',
  'skipped_disabled',
  'skipped_definition_only',
  'unsupported',
  'busy',
  'insufficient_privileges',
  'verification_failed',
  'failed',
] as const;
export type RestorePointStatus = (typeof RESTORE_POINT_STATUSES)[number];

/** The command-payload key the block is stamped under. */
export const RESTORE_POINT_PAYLOAD_KEY = 'restorePoint' as const;

/** The only block version agents understand; any other `v` is read as "missing". */
export const RESTORE_POINT_REQUEST_VERSION = 1 as const;

/**
 * The block stamped into the command payload. EXACTLY these keys -- the agent
 * parser reads them by name, and a missing/renamed block falls back to legacy
 * defaults (install_patches: enabled; script/software_install: disabled).
 *
 * `policyRevision` is always a string on the wire ('' when no policy revision
 * applies); the agent reads a non-string as empty anyway.
 */
export interface RestorePointRequestBlock {
  v: typeof RESTORE_POINT_REQUEST_VERSION;
  requestId: string;
  enabled: boolean;
  label: string;
  resolvedAt: string;
  policyRevision: string;
  validUntil: string;
}

export const RESTORE_POINT_REQUEST_BLOCK_KEYS = [
  'v',
  'requestId',
  'enabled',
  'label',
  'resolvedAt',
  'policyRevision',
  'validUntil',
] as const satisfies ReadonlyArray<keyof RestorePointRequestBlock>;

// Compile-time: every interface key is listed above (the `satisfies` clause
// covers the other direction), so the key-set pin test also pins the type.
type _AllBlockKeysListed =
  Exclude<keyof RestorePointRequestBlock, (typeof RESTORE_POINT_REQUEST_BLOCK_KEYS)[number]> extends never
    ? true
    : never;
const _allBlockKeysListed: _AllBlockKeysListed = true;
void _allBlockKeysListed;

/** What the agent returns on the command result (ingested from W06 on). */
export interface RestorePointOutcome {
  status: Exclude<RestorePointStatus, 'requested'>;
  requestId: string;
  /** Decimal STRING: Windows sequence numbers are INT64 and exceed the JS safe range. */
  sequenceNumber?: string;
  description?: string;
  message?: string;
  attemptedAt: string;
  durationMs: number;
  existingPointAgeMinutes?: number;
  frequencyMinutes?: number;
}
