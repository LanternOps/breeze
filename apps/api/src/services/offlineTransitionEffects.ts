/** Durable effect execution: short fenced database transactions around external I/O. */
import { assertOutsideHeldDbContext } from '../db';
import type { OfflineEffect } from '../db/schema';
import { publishEvent } from './eventBus';
import { admitOfflineAlertRule, expandOfflineAlertPlan, postprocessOfflineAlert } from './offlineAlertEffects';
import { claimOfflineEffect, finishOfflineEffect, retryOfflineEffect, withOfflineEffectLease } from './offlineEffectsStore';

async function execute(effect: OfflineEffect, enqueue?: (ids: string[]) => Promise<void>): Promise<void> {
  const p = effect.payload;
  if (p.type !== effect.kind) throw new Error('Offline effect kind mismatch');
  if ('observation' in p && (p.observation.orgId !== effect.orgId || p.observation.deviceId !== effect.deviceId)) {
    throw new Error('Offline effect observation ownership mismatch');
  }
  if (p.type === 'alert-event' && p.event.deviceId !== effect.deviceId) throw new Error('Offline alert device mismatch');
  switch (p.type) {
    case 'alert-plan': {
      const ids = await expandOfflineAlertPlan(effect);
      if (ids.length && enqueue) await enqueue(ids);
      return;
    }
    case 'alert-rule': {
      const ids = await admitOfflineAlertRule(effect);
      if (ids.length && enqueue) await enqueue(ids);
      return;
    }
    case 'offline-event':
      await publishEvent('device.offline', effect.orgId, {
        deviceId: effect.deviceId, hostname: p.observation.hostname,
        displayName: p.observation.displayName, lastSeenAt: p.observation.observedLastSeenAt,
      }, 'offline-detector', {
        siteId: p.observation.siteId, eventId: effect.id, occurredAt: effect.createdAt.toISOString(),
      });
      break;
    case 'alert-event':
      await publishEvent('alert.triggered', effect.orgId, p.event, 'alert-service', {
        siteId: p.siteId, eventId: effect.id, occurredAt: p.occurredAt,
      });
      break;
    case 'alert-postprocess':
      await postprocessOfflineAlert(effect);
      break;
    default:
      throw new Error('Unknown offline effect payload');
  }
  await withOfflineEffectLease(effect, () => finishOfflineEffect(effect));
}

export async function processOfflineEffect(id: string, enqueue?: (ids: string[]) => Promise<void>): Promise<{ claimed: boolean }> {
  assertOutsideHeldDbContext('processOfflineEffect');
  const effect = await claimOfflineEffect(id);
  if (!effect) return { claimed: false };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // A timed-out Redis operation may still complete later. Its stable event ID
    // preserves logical identity; lease fencing prevents late DB acknowledgements.
    await Promise.race([
      execute(effect, enqueue),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Offline effect execution deadline exceeded')), 30_000);
      }),
    ]);
    return { claimed: true };
  } catch (error) {
    await retryOfflineEffect(effect);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
