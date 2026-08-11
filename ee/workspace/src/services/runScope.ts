/**
 * The run/index "scope" convention, in one place.
 *
 * SMB sources are crawled source-scoped: exactly one org-wide partition,
 * stored as deviceId = NULL with deviceKey = SHARED_DEVICE_KEY. local_profile
 * sources are crawled device-scoped: one partition per device, stored as
 * deviceId = deviceKey = <device>.
 *
 * deviceKey exists because the unique index on workspace_file_index is
 * (org_id, source_id, device_key, rel_path) and Postgres treats NULLs as
 * distinct in unique indexes — keying on nullable device_id would let SMB rows
 * duplicate freely. The invariant device_key = COALESCE(device_id, zero-uuid)
 * is enforced by application code only (no DB trigger); every writer must go
 * through this module.
 */
export const SHARED_DEVICE_KEY = '00000000-0000-0000-0000-000000000000';

export type RunScope = { deviceId: string | null; deviceKey: string };

export function smbScope(): RunScope {
  return { deviceId: null, deviceKey: SHARED_DEVICE_KEY };
}

export function deviceScope(deviceId: string): RunScope {
  return { deviceId, deviceKey: deviceId };
}

/**
 * The scope a device may operate under for a source; null when the source is
 * not assigned to that device (SMB sources are owned by their crawl device).
 */
export function scopeForDevice(
  source: { kind: 'smb_share' | 'local_profile'; crawlDeviceId: string | null },
  deviceId: string,
): RunScope | null {
  if (source.kind === 'smb_share') {
    return source.crawlDeviceId === deviceId ? smbScope() : null;
  }
  return deviceScope(deviceId);
}

export function matchesScope(
  row: { deviceId: string | null; deviceKey: string },
  scope: RunScope,
): boolean {
  return row.deviceId === scope.deviceId && row.deviceKey === scope.deviceKey;
}

/** Inverse of the COALESCE convention: shared key maps back to a NULL device. */
export function deviceIdFromKey(deviceKey: string): string | null {
  return deviceKey === SHARED_DEVICE_KEY ? null : deviceKey;
}
