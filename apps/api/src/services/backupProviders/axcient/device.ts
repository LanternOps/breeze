import type { ExternalBackupStatus } from '@breeze/shared';
import { parseCoveMacAddresses } from '../cove/columns';
import { ProviderRequestError, type VendorDevice, type VerifiedBootableEvidence } from '../types';
import type { AxcientRecord } from './client';

function isRecord(value: unknown): value is AxcientRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function date(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/** `backup_provider_devices` stores bytes as bigint, which rejects fractions and junk. */
function bytes(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function identity(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return text(value)?.trim() ?? null;
}

/** The newest of the local, private-vault and cloud recovery points. */
function latestRecoveryPoint(device: AxcientRecord): Date | null {
  let latest: Date | null = null;
  for (const key of ['latest_local_rp', 'latest_vault_rp', 'latest_cloud_rp']) {
    const point = date(device[key]);
    if (point && (!latest || point > latest)) latest = point;
  }
  return latest;
}

/**
 * Verdict first, then reason, then whether any recovery point exists. Reasons
 * are an open list (the API example says `APPLIANCE_OFFLINE`, the help centre
 * `APPLIANCE_OFFLINED`), so an unrecognised one is "anything else" and never
 * throws. AutoVerify never changes the status.
 */
export function mapAxcientStatus(device: AxcientRecord): ExternalBackupStatus {
  const health = device.current_health_status;
  if (!isRecord(health) || typeof health.status !== 'string') return 'unknown';
  switch (health.status.toUpperCase()) {
    case 'NORMAL': return 'completed';
    case 'WARNED': return 'completed_with_errors';
    case 'PARKED': return 'paused';
    case 'UNPROTECTED': return 'no_backups';
    case 'TROUBLED': {
      const reason = typeof health.reason === 'string' ? health.reason.toUpperCase() : '';
      if (reason === 'OFFSITE_NEVER_RUN') return 'no_backups';
      if (reason === 'SCHEDULE_DISABLED') return 'no_selection';
      return latestRecoveryPoint(device) ? 'failed' : 'no_backups';
    }
    default: return 'unknown';
  }
}

export function mapAxcientOsType(type: unknown): 'workstation' | 'server' | 'unknown' {
  const normalised = typeof type === 'string' ? type.toUpperCase() : '';
  if (normalised === 'SERVER') return 'server';
  if (normalised === 'WORKSTATION') return 'workstation';
  return 'unknown';
}

const AUTOVERIFY_CHECKS = ['system_boot', 'heartbeat', 'check_disk', 'start_vss'] as const;
const FAILED_RESULT = /^(failure|failed|error)$/i;

function checkFailed(value: unknown): boolean {
  if (value === false) return true;
  if (!isRecord(value)) return false;
  return value.result === false || (typeof value.result === 'string' && FAILED_RESULT.test(value.result));
}

/**
 * `status` says whether the check ran to completion; `is_healthy` whether it
 * passed. Only both together are a pass. Per-check shapes are inferred from
 * the OpenAPI example (`{ result: 'passed' | 'failed' }`); W03 confirms them
 * against a live account, and any other shape is ignored rather than guessed.
 */
export function axcientVerifiedBootable(details: unknown): VerifiedBootableEvidence | null {
  if (!isRecord(details) || typeof details.is_healthy !== 'boolean') return null;
  return {
    at: date(details.end_timestamp),
    healthy: details.status === 'success' && details.is_healthy === true,
    failedChecks: AUTOVERIFY_CHECKS.filter((check) => checkFailed(details[check])),
  };
}

const BULK_KEYS = new Set(['jobs', 'volumes', 'excluded_volumes', 'vaults']);
const PRESIGNED_KEY = /screenshot/i;

function withoutPresigned(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPresigned);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !PRESIGNED_KEY.test(key)).map(([key, item]) => [key, withoutPresigned(item)]),
  );
}

/**
 * The device minus bulk arrays and every screenshot URL. The screenshot links
 * are presigned, so they are dropped at any depth before anything is stored.
 * The input is not changed.
 */
export function scrubAxcientRaw(device: AxcientRecord): Record<string, unknown> {
  const kept = Object.fromEntries(Object.entries(device).filter(([key]) => !BULK_KEYS.has(key)));
  return withoutPresigned(kept) as Record<string, unknown>;
}

/**
 * Project one `/client/{id}/device` row onto `VendorDevice`. Pure.
 *
 * Throws when the row has no `id` or `client_id`: a row we cannot key would
 * upsert under a blank `vendor_device_id` and overwrite another device's
 * status, and a row we cannot attribute has no customer mapping to land under.
 */
export function axcientDeviceToVendorDevice(device: AxcientRecord): VendorDevice {
  const vendorDeviceId = identity(device.id);
  const vendorCustomerId = identity(device.client_id);
  if (!vendorDeviceId || !vendorCustomerId) {
    throw new ProviderRequestError('Axcient device has no id or client id', { code: 'malformed_response', reauth: false });
  }
  const name = text(device.name);
  const os = isRecord(device.os) ? device.os : {};
  const status = mapAxcientStatus(device);
  const health = isRecord(device.current_health_status) ? device.current_health_status : {};
  const lastSuccessAt = latestRecoveryPoint(device);
  return {
    vendorDeviceId,
    vendorCustomerId,
    name: name ?? vendorDeviceId,
    // `name` is the agent hostname as far as the API documents it (inferred;
    // W03 checks). Without one there is nothing safe to match on.
    computerName: name,
    osType: mapAxcientOsType(device.type),
    osVersion: text(os.os_name),
    clientVersion: text(device.agent_version),
    macAddresses: parseCoveMacAddresses(device.mac_address),
    accountType: 'backup_manager',
    // x360Recover is image-level for appliance and D2C devices alike; where
    // the image lives stays in `raw`.
    dataSources: ['image'],
    status,
    vendorStatusCode: null,
    // Axcient exposes no session at device level and job history is
    // unreliable, so the newest recovery point stands in for all three.
    lastSessionAt: lastSuccessAt,
    lastSuccessAt,
    lastCompletedAt: lastSuccessAt,
    selectedBytes: bytes(device.local_total),
    usedBytes: bytes(device.d2c === true ? device.cloud_usage : device.local_usage),
    errorsCount: typeof health.status === 'string' && health.status.toUpperCase() === 'NORMAL' ? 0 : 1,
    vendorCreatedAt: null,
    vendorExpiresAt: null,
    raw: scrubAxcientRaw(device),
    verifiedBootable: axcientVerifiedBootable(device.latest_autoverify_details),
  };
}
