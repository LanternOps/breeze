/**
 * Whether a backup destination honours a create-only write condition
 * (`If-None-Match: *` on PUT and on multipart completion), recorded on
 * `backup_configs.provider_capabilities.conditionalWrites`.
 *
 * The result is bound to the storage identity it was probed against, so a
 * destination edit invalidates it even when the stored capabilities survive
 * the edit. It is refreshed at most daily, in the background, when a brokered
 * write is issued for the configuration; until a probe has succeeded the
 * destination is treated as NOT supporting the condition, which only makes
 * publication wait for every issued upload URL to expire (the safe default).
 */
import { eq, sql } from 'drizzle-orm';
import { db, runAfterDbContextExit, withSystemDbAccessContext } from '../db';
import { backupConfigs } from '../db/schema';
import { normalizeStorageIdentity } from '../jobs/backupRetention';
import { resolveBackupProviderConfig } from './backupProviderConfig';
import { probeConditionalWrites } from './backupStoragePresign';

export const CONDITIONAL_WRITE_PROBE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type ConditionalWritesRecord = { supported: boolean; probedAt: string; storageIdentity: string };

function recordOf(caps: unknown): ConditionalWritesRecord | null {
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) return null;
  const raw = (caps as Record<string, unknown>).conditionalWrites;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.supported !== 'boolean' || typeof r.probedAt !== 'string' || typeof r.storageIdentity !== 'string') {
    return null;
  }
  return { supported: r.supported, probedAt: r.probedAt, storageIdentity: r.storageIdentity };
}

/** The recorded result for this identity, or "unsupported" when there is none. */
export function readConditionalWrites(caps: unknown, storageIdentity: string): { supported: boolean; probedAt: Date | null } {
  const rec = recordOf(caps);
  if (!rec || rec.storageIdentity !== storageIdentity) return { supported: false, probedAt: null };
  const probedAt = new Date(rec.probedAt);
  if (Number.isNaN(probedAt.getTime())) return { supported: false, probedAt: null };
  return { supported: rec.supported, probedAt };
}

export function conditionalWriteProbeDue(caps: unknown, storageIdentity: string, now: Date): boolean {
  const { probedAt } = readConditionalWrites(caps, storageIdentity);
  return !probedAt || now.getTime() - probedAt.getTime() > CONDITIONAL_WRITE_PROBE_MAX_AGE_MS;
}

export function withConditionalWriteProbe(
  caps: unknown,
  supported: boolean,
  storageIdentity: string,
  now: Date,
): Record<string, unknown> {
  const base = caps && typeof caps === 'object' && !Array.isArray(caps) ? { ...(caps as Record<string, unknown>) } : {};
  return { ...base, conditionalWrites: { supported, probedAt: now.toISOString(), storageIdentity } };
}

const inFlight = new Set<string>();

/**
 * Probes one configuration and records the result. Runs with NO DB context
 * held across the storage calls: a short system read, the probe, then a short
 * system write that only lands if the destination still has the identity that
 * was probed.
 */
export async function refreshConditionalWriteProbe(configId: string, orgId: string): Promise<boolean | null> {
  const destination = await withSystemDbAccessContext(() => resolveBackupProviderConfig(configId, orgId));
  if (!destination || destination.provider !== 's3') return null;
  const identity = normalizeStorageIdentity(destination.provider, destination.providerConfig);
  const supported = await probeConditionalWrites(destination.providerConfig);
  await withSystemDbAccessContext(async () => {
    const current = await resolveBackupProviderConfig(configId, orgId);
    if (!current || normalizeStorageIdentity(current.provider, current.providerConfig) !== identity) return;
    const record = withConditionalWriteProbe({}, supported, identity, new Date()).conditionalWrites;
    await db
      .update(backupConfigs)
      .set({
        providerCapabilities: sql`COALESCE(${backupConfigs.providerCapabilities}, '{}'::jsonb) || jsonb_build_object('conditionalWrites', ${JSON.stringify(record)}::jsonb)`,
      })
      .where(eq(backupConfigs.id, configId));
  });
  return supported;
}

/**
 * Queues a background probe for a configuration after the caller's DB
 * context exits (never while a delivery transaction is held). At most one
 * probe per configuration runs at a time in this process; failures are
 * logged and leave the recorded value unchanged.
 */
export function scheduleConditionalWriteProbe(configId: string, orgId: string): void {
  if (inFlight.has(configId)) return;
  inFlight.add(configId);
  runAfterDbContextExit('backupStorageCapabilityProbe.refresh', async () => {
    try {
      await refreshConditionalWriteProbe(configId, orgId);
    } catch (err) {
      console.warn('[backupStorageCapabilityProbe] conditional-write probe failed', {
        configId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inFlight.delete(configId);
    }
  });
}
