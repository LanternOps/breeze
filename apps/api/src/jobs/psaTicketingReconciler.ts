import { admitAlert, type AdmissionTarget } from '../services/psaAlertTicketing/admission';
import {
  activeTargets,
  admissionCandidates,
  dueMappings,
  wakeTicketMapping,
} from '../services/psaAlertTicketing/storage';
import { captureException } from '../services/sentry';
export function makeReconcile(deps: {
  targets(): Promise<AdmissionTarget[]>;
  candidates(
    connectionId: string,
    floor: Date,
    config: AdmissionTarget['config']
  ): Promise<string[]>;
  admit: typeof admitAlert;
  wakeDue(now: Date): Promise<string[]>;
  wake(id: string): Promise<void>;
}) {
  return async (now = new Date()) => {
    const counts = { targets: 0, admitted: 0, woken: 0, errors: 0 };
    const report = (error: unknown, connectionId?: string, mappingId?: string, alertId?: string) => {
      counts.errors++;
      console.error('[psa-ticketing] reconciler operation failed', { connectionId, mappingId, alertId, error });
      captureException(error, undefined, connectionId ? { psa_connection_id: connectionId } : undefined);
    };
    try {
      const targets = await deps.targets();
      counts.targets = targets.length;
      for (const target of targets) {
        try {
          const floor = new Date(Math.max(target.enabledAt.getTime(), now.getTime() - target.config.lookbackHours * 3600000));
          for (const id of await deps.candidates(target.connectionId, floor, target.config)) {
            try {
              if (await deps.admit(id, 'auto') === 'admitted') counts.admitted++;
            } catch (error) { report(error, target.connectionId, undefined, id); }
          }
        } catch (error) { report(error, target.connectionId); }
      }
    } catch (error) { report(error); }
    // Admission failures never suppress recovery of mappings already in the ledger.
    try {
      for (const id of await deps.wakeDue(now)) {
        try { await deps.wake(id); counts.woken++; }
        catch (error) { report(error, undefined, id); }
      }
    } catch (error) { report(error); }
    console.info('[psa-ticketing] reconciler tick', counts);
  };
}
export const reconcilePsaTicketing = makeReconcile({
  targets: activeTargets,
  candidates: admissionCandidates,
  admit: admitAlert,
  wakeDue: dueMappings,
  wake: wakeTicketMapping,
});
let timer: ReturnType<typeof setInterval> | null = null;
let active: Promise<void> | null = null;
export function initializePsaTicketingReconciler() {
  if (timer) return;
  const tick = () => {
    if (!active)
      active = reconcilePsaTicketing()
        .catch(captureException)
        .finally(() => {
          active = null;
        });
  };
  timer = setInterval(tick, 120000);
  timer.unref();
  tick();
}
export async function shutdownPsaTicketingReconciler() {
  if (timer) clearInterval(timer);
  timer = null;
  await active;
}
