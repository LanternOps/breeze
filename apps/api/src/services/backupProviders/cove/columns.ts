import type { ExternalBackupStatus } from '@breeze/shared';
import type { VendorDevice } from '../types';

/**
 * Cove column codes, from the vendor's `EnumerateAccountStatistics` catalog.
 * Unknown codes are silently ignored by the API, so over-requesting is safe and
 * under-requesting is silent — hence the named constants.
 */
export const COVE_COLUMN = {
  ACCOUNT_ID: 'I0',
  NAME: 'I1',
  CUSTOMER_NAME: 'I8',
  USED_STORAGE_BYTES: 'I14',
  OS_VERSION: 'I16',
  CLIENT_VERSION: 'I17',
  COMPUTER_NAME: 'I18',
  MAC_ADDRESSES: 'I21',
  OS_TYPE: 'I32',
  ACCOUNT_TYPE: 'I59',
  DATA_SOURCES: 'I78',
  /** D09Fnn = totals across ALL data sources. */
  LAST_SESSION_STATUS: 'D09F00',
  ERRORS: 'D09F06',
  SELECTED_BYTES: 'D09F07',
  /** Cove's opaque 28-day colour bar. Requested and stored raw, never decoded — the ledger is ours. */
  COLOUR_BAR: 'D09F08',
  LAST_SUCCESS_TS: 'D09F09',
  LAST_SESSION_TS: 'D09F15',
  LAST_COMPLETED_TS: 'D09F18',
} as const;

/** The exact `Columns` array sent with every statistics page. */
export const COVE_STATISTIC_COLUMNS: readonly string[] = [
  COVE_COLUMN.ACCOUNT_ID,
  COVE_COLUMN.NAME,
  COVE_COLUMN.CUSTOMER_NAME,
  COVE_COLUMN.USED_STORAGE_BYTES,
  COVE_COLUMN.OS_VERSION,
  COVE_COLUMN.CLIENT_VERSION,
  COVE_COLUMN.COMPUTER_NAME,
  COVE_COLUMN.MAC_ADDRESSES,
  COVE_COLUMN.OS_TYPE,
  COVE_COLUMN.ACCOUNT_TYPE,
  COVE_COLUMN.DATA_SOURCES,
  COVE_COLUMN.LAST_SESSION_STATUS,
  COVE_COLUMN.ERRORS,
  COVE_COLUMN.SELECTED_BYTES,
  COVE_COLUMN.COLOUR_BAR,
  COVE_COLUMN.LAST_SUCCESS_TS,
  COVE_COLUMN.LAST_SESSION_TS,
  COVE_COLUMN.LAST_COMPLETED_TS,
];

/** One row as `EnumerateAccountStatistics` returns it. */
export interface CoveStatisticsRow {
  AccountId: number | string | null;
  PartnerId: number | string | null;
  Flags?: unknown;
  Settings?: Array<Record<string, unknown>>;
}

/**
 * Cove returns `Settings` as an ARRAY of single-key objects, not a map. Flatten
 * it, tolerating multi-key entries and junk rather than throwing: a single
 * malformed entry must not cost us the whole device inventory.
 *
 * A duplicated key lets the LATER value win — if the vendor ever re-sends a
 * column, the freshest value is the one that means something.
 */
export function parseCoveSettings(settings: Array<Record<string, unknown>> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(settings)) return out;
  for (const entry of settings) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    for (const [key, value] of Object.entries(entry)) out[key] = value;
  }
  return out;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/**
 * Cove timestamps are Unix SECONDS, and `0` means "no such session". Treating 0
 * as an epoch Date would claim a 1970 backup — the device would read as merely
 * stale instead of never-backed-up, which is the difference between a warning
 * and "this customer has no protection".
 */
export function coveUnixToDate(value: unknown): Date | null {
  const seconds = toNumber(value);
  if (seconds === null || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

/**
 * `D09F00` -> the shared status enum (spec "Normalized status and health").
 *
 *   1 InProcess, 12 Restarted        -> in_progress
 *   9 InProgressWithFaults           -> in_progress (the faults ride on errorsCount)
 *   2 Failed                         -> failed
 *   3 Aborted, 6 Interrupted         -> interrupted
 *   5 Completed                      -> completed
 *   7 NotStarted                     -> not_started
 *   8 CompletedWithErrors            -> completed_with_errors
 *   10 OverQuota                     -> over_quota
 *   11 NoSelection                   -> no_selection
 *
 * ABSENT (the column is missing from `Settings` entirely) is `no_backups` — a
 * real, actionable state — while an UNRECOGNISED code is `unknown`, a gap in
 * OUR mapping that must be visible rather than rendered green or red. The
 * client logs an unrecognised code once per sync with its value, and
 * `vendor_status_code` keeps it on the row.
 */
export function mapCoveSessionStatus(code: number | null | undefined): ExternalBackupStatus {
  if (code === null || code === undefined) return 'no_backups';
  switch (code) {
    case 1:
    case 9:
    case 12:
      return 'in_progress';
    case 2:
      return 'failed';
    case 3:
    case 6:
      return 'interrupted';
    case 5:
      return 'completed';
    case 7:
      return 'not_started';
    case 8:
      return 'completed_with_errors';
    case 10:
      return 'over_quota';
    case 11:
      return 'no_selection';
    default:
      return 'unknown';
  }
}

/** `I32`: 1 workstation, 2 server, 0/absent/anything else undefined. */
export function mapCoveOsType(value: unknown): 'workstation' | 'server' | 'unknown' {
  switch (toNumber(value)) {
    case 1: return 'workstation';
    case 2: return 'server';
    default: return 'unknown';
  }
}

/** `I59`: 1 Backup Manager (an endpoint), 2 M365 (a cloud mailbox account), 0/else unknown. */
export function mapCoveAccountType(value: unknown): 'backup_manager' | 'm365' | 'unknown' {
  switch (toNumber(value)) {
    case 1: return 'backup_manager';
    case 2: return 'm365';
    default: return 'unknown';
  }
}

/**
 * `I78` is the active data sources as CONCATENATED three-character codes
 * ("D01D02D10"), not a delimited list.
 *
 * Only the ten codes the spec verifies are mapped; every other `Dnn` becomes
 * `other` (once), and the raw `I78` string stays in `vendor_raw` so an
 * unmapped code is diagnosable without a redeploy. A ragged trailing chunk is
 * dropped rather than mis-decoded.
 */
const COVE_DATA_SOURCE_BY_CODE: Readonly<Record<string, string>> = {
  D01: 'files',
  D02: 'system_state',
  D05: 'm365_sharepoint',
  D08: 'vmware',
  D10: 'mssql',
  D14: 'hyperv',
  D17: 'bare_metal',
  D19: 'm365_exchange',
  D20: 'm365_onedrive',
  D23: 'm365_teams',
};

export function parseCoveDataSources(i78: string | null | undefined): string[] {
  const raw = toText(i78);
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 3 <= raw.length; i += 3) {
    const code = raw.slice(i, i + 3).toUpperCase();
    const name = COVE_DATA_SOURCE_BY_CODE[code] ?? 'other';
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * `I21` may hold one MAC or several, separated by comma, semicolon or
 * whitespace, in colon, hyphen or Cisco dot form. Normalize to lower-case
 * colon-separated so W02's MAC tiebreaker can compare against Breeze's own
 * interface records without re-deriving the rule.
 *
 * The all-zero MAC is dropped: a Cove agent on a host with no resolvable NIC
 * reports `00:00:00:00:00:00`, and matching on it would link every such host to
 * the same Breeze device.
 */
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

export function parseCoveMacAddresses(value: unknown): string[] {
  const raw = toText(value);
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of raw.split(/[,;\s]+/)) {
    const compact = token.replace(/[.:-]/g, '').toLowerCase();
    if (compact.length !== 12 || !/^[0-9a-f]{12}$/.test(compact)) continue;
    const mac = compact.match(/.{2}/g)!.join(':');
    if (!MAC_RE.test(mac)) continue;
    if (mac === '00:00:00:00:00:00') continue;
    if (seen.has(mac)) continue;
    seen.add(mac);
    out.push(mac);
  }
  return out;
}

/**
 * Project one `EnumerateAccountStatistics` row onto the vendor-neutral
 * `VendorDevice`. Pure — the sync job does all the tenancy work.
 *
 * Throws when the row has no `AccountId`/`I0` or no `PartnerId`: a row we
 * cannot key would upsert under a blank `vendor_device_id` and collide with
 * every other identity-less row on `(connection_id, vendor_device_id)`,
 * silently overwriting one device's status with another's.
 */
export function coveRowToVendorDevice(row: CoveStatisticsRow): VendorDevice {
  const settings = parseCoveSettings(row.Settings);

  const vendorDeviceId = toText(row.AccountId) ?? toText(settings[COVE_COLUMN.ACCOUNT_ID]);
  if (!vendorDeviceId) {
    throw new Error('Cove statistics row has no AccountId (and no I0) — cannot key the device');
  }
  const vendorCustomerId = toText(row.PartnerId);
  if (!vendorCustomerId) {
    throw new Error(`Cove statistics row ${vendorDeviceId} has no PartnerId — cannot attribute the device`);
  }

  const accountType = mapCoveAccountType(settings[COVE_COLUMN.ACCOUNT_TYPE]);
  const isEndpoint = accountType !== 'm365';
  const statusCode = settings[COVE_COLUMN.LAST_SESSION_STATUS] === undefined
    ? null
    : toNumber(settings[COVE_COLUMN.LAST_SESSION_STATUS]);

  return {
    vendorDeviceId,
    vendorCustomerId,
    name: toText(settings[COVE_COLUMN.NAME]) ?? vendorDeviceId,
    // An M365 account has no computer identity, and inventing one from the
    // tenant domain would let the device matcher link a mailbox to a server.
    computerName: isEndpoint ? toText(settings[COVE_COLUMN.COMPUTER_NAME]) : null,
    osType: mapCoveOsType(settings[COVE_COLUMN.OS_TYPE]),
    osVersion: toText(settings[COVE_COLUMN.OS_VERSION]),
    clientVersion: toText(settings[COVE_COLUMN.CLIENT_VERSION]),
    macAddresses: isEndpoint ? parseCoveMacAddresses(settings[COVE_COLUMN.MAC_ADDRESSES]) : [],
    accountType,
    dataSources: parseCoveDataSources(toText(settings[COVE_COLUMN.DATA_SOURCES])),
    // `settings[D09F00] === undefined` (never ran) is `no_backups`; a present
    // but unrecognised value is `unknown`.
    status: settings[COVE_COLUMN.LAST_SESSION_STATUS] === undefined
      ? 'no_backups'
      : mapCoveSessionStatus(statusCode ?? Number.NaN),
    vendorStatusCode: statusCode,
    lastSessionAt: coveUnixToDate(settings[COVE_COLUMN.LAST_SESSION_TS]),
    lastSuccessAt: coveUnixToDate(settings[COVE_COLUMN.LAST_SUCCESS_TS]),
    lastCompletedAt: coveUnixToDate(settings[COVE_COLUMN.LAST_COMPLETED_TS]),
    selectedBytes: toNumber(settings[COVE_COLUMN.SELECTED_BYTES]),
    usedBytes: toNumber(settings[COVE_COLUMN.USED_STORAGE_BYTES]),
    errorsCount: toNumber(settings[COVE_COLUMN.ERRORS]) ?? 0,
    // No documented column in this call carries account creation or expiry;
    // phase 2 reads them through ModifyAccount. Populating them from a guessed
    // code would put unverified data into a tenant export.
    vendorCreatedAt: null,
    vendorExpiresAt: null,
    raw: settings,
  };
}
