import type { BreezeEvent } from '../eventBus';
import { admitAlert } from './admission';
import { wakeAlertMappings } from './storage';
export async function handlePsaAlertEvent(event: BreezeEvent) {
  const alertId = (event.payload as { alertId?: string }).alertId;
  if (!alertId) return;
  if (event.type === 'alert.triggered') await admitAlert(alertId, 'auto');
  else if (event.type === 'alert.acknowledged' || event.type === 'alert.resolved') await wakeAlertMappings(alertId);
}
