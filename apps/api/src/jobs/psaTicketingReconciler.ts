import { admitAlert, type AdmissionTarget } from '../services/psaAlertTicketing/admission';
import { activeTargets, admissionCandidates, dueMappings } from '../services/psaAlertTicketing/storage';
import { wakeMapping } from '../services/psaAlertTicketing/queue';
import { captureException } from '../services/sentry';
export function makeReconcile(deps: {
  targets(): Promise<AdmissionTarget[]>; candidates(connectionId: string, floor: Date): Promise<string[]>;
  admit: typeof admitAlert; wakeDue(now: Date): Promise<string[]>; wake(id: string): Promise<void>;
}) {
  return async (now = new Date()) => {
    for (const target of await deps.targets()) {
      const floor = new Date(Math.max(target.enabledAt.getTime(), now.getTime() - target.config.lookbackHours * 3600000));
      for (const id of await deps.candidates(target.connectionId, floor)) await deps.admit(id, 'auto');
    }
    for (const id of await deps.wakeDue(now)) await deps.wake(id);
  };
}
export const reconcilePsaTicketing = makeReconcile({ targets: activeTargets, candidates: admissionCandidates,
  admit: admitAlert, wakeDue: dueMappings, wake: wakeMapping });
let timer: ReturnType<typeof setInterval> | null = null;
let active: Promise<void> | null = null;
export function initializePsaTicketingReconciler() {
  if (timer) return;
  const tick = () => { if (!active) active = reconcilePsaTicketing().catch(captureException).finally(() => { active = null; }); };
  timer = setInterval(tick, 120000); timer.unref(); tick();
}
export async function shutdownPsaTicketingReconciler() { if (timer) clearInterval(timer); timer = null; await active; }
