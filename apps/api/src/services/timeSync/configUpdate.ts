import { createHash } from 'node:crypto';
import { hierarchyFor } from '../deviceHierarchy';
import type { DevicePolicySetOpts } from '../devicePolicySet';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices, sites } from '../../db/schema';
import { getDeviceTimeSyncSettings } from './settings';
import { resolveExpectedTimezone } from './expectedTimezone';

/** Wire payload for `configUpdate.time_sync_settings` (index §F.2). */
export interface TimeSyncConfigUpdate {
  enforce_ntp: boolean;
  ntp_servers: string[];
  poll_interval_minutes: number;
  timezone: { expected_windows_id: string | null; auto_fix: boolean };
  fingerprint: string;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Canonical JSON: object keys sorted at every depth, array order preserved
 * (NTP server order is a preference order and is part of the fingerprint).
 */
export function canonicalTimeSyncJson(value: JsonValue): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalTimeSyncJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalTimeSyncJson(value[key]!)}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Resolves the device's effective time-sync settings and expected Windows
 * timezone into the agent wire payload. Throws on any resolver error — the
 * heartbeat omits the key rather than sending defaults that could revert
 * enforcement.
 */
export async function buildResolvedTimeSyncConfigUpdate(
  deviceId: string,
  opts?: DevicePolicySetOpts,
): Promise<TimeSyncConfigUpdate> {
  const passed = hierarchyFor(deviceId, opts);
  const resolved = await getDeviceTimeSyncSettings(deviceId, opts);
  // #8053 W1a-1: the site rides in the passed hierarchy; null there means the
  // same as this inner join finding no row.
  const [site] = passed
    ? (passed.site ? [{ id: passed.site.id, name: passed.site.name, timezone: passed.site.timezone }] : [])
    : await db
      .select({ id: sites.id, name: sites.name, timezone: sites.timezone })
      .from(devices)
      .innerJoin(sites, eq(devices.siteId, sites.id))
      .where(eq(devices.id, deviceId))
      .limit(1);
  const expected = resolveExpectedTimezone({
    site: site ?? null,
    policy: resolved.policy,
  });
  const body = {
    enforce_ntp: resolved.settings.enforceNtp,
    ntp_servers: resolved.settings.ntpServers,
    poll_interval_minutes: resolved.settings.pollIntervalMinutes,
    timezone: {
      expected_windows_id: expected?.windowsId ?? null,
      auto_fix: resolved.settings.timezone.autoFix,
    },
  };
  return {
    ...body,
    fingerprint: `sha256:${createHash('sha256').update(canonicalTimeSyncJson(body)).digest('hex')}`,
  };
}
