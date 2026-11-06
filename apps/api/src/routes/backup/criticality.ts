import { and, eq } from 'drizzle-orm';
import { db, withDbTransactionIfHeld, withSystemDbAccessContextIsolated } from '../../db';
import { reportBackupDbFallback } from './dbFallbackReport';
import { devices as devicesTable } from '../../db/schema';
import { resolveBackupConfigForDevice } from '../../services/featureConfigResolver';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_CRITICAL_TAGS = ['critical', 'tier0', 'tier1'];


function isUuid(value?: string | null): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function normalizeConfiguredTags(raw: string | undefined): Set<string> {
  const configured = raw
    ?.split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  return new Set((configured && configured.length > 0 ? configured : DEFAULT_CRITICAL_TAGS));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasCriticalMetadata(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;

  if (record.critical === true) return true;

  const normalized = [record.criticality, record.priority, record.tier]
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase());

  return normalized.some((entry) => entry === 'critical' || entry === 'tier0' || entry === 'tier1');
}

/**
 * A failed lookup answers "not critical", so a caller that reports a verdict passes
 * `onDbReadFailure` and must not treat that answer as known.
 */
export async function isCriticalBackupDevice(
  orgId: string,
  deviceId: string,
  onDbReadFailure?: () => void,
): Promise<boolean> {
  const criticalTags = normalizeConfiguredTags(process.env.BACKUP_CRITICAL_DEVICE_TAGS);

  if (isUuid(orgId) && isUuid(deviceId)) {
    try {
      const [device] = await withSystemDbAccessContextIsolated(() => db
        .select({ tags: devicesTable.tags })
        .from(devicesTable)
        .where(and(
          eq(devicesTable.id, deviceId),
          eq(devicesTable.orgId, orgId)
        ))
        .limit(1));

      if (device?.tags?.some((tag) => criticalTags.has(tag.trim().toLowerCase()))) {
        return true;
      }
    } catch (error) {
      reportBackupDbFallback('[backupVerification] Failed to read device tags for criticality', error);
      onDbReadFailure?.();
    }
  }

  try {
    const resolved = await withDbTransactionIfHeld(() => resolveBackupConfigForDevice(deviceId));
    if (!resolved) return false;

    if (hasCriticalMetadata(resolved.inlineSettings)) return true;
    if (hasCriticalMetadata(resolved.settings)) return true;
    if (hasCriticalMetadata(asRecord(resolved.settings)?.targets)) return true;
  } catch (error) {
    reportBackupDbFallback('[backupVerification] Failed to resolve backup criticality metadata', error);
    onDbReadFailure?.();
  }

  return false;
}
