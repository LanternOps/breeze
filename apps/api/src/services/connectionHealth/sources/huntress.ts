import { huntressIntegrations } from '../../../db/schema';
import { huntressHealth } from '../../integrationStates';
import { partnerSyncSource } from './partnerSync';

// Sync runs every 15 minutes; only the final attempt writes 'error'
// (jobs/huntressSync.ts), and a queued run sets 'running' first.
const huntress = partnerSyncSource({
  kind: 'huntress',
  table: huntressIntegrations,
  tableName: 'huntress_integrations',
  intervalMinutes: 15,
  failedValue: 'error',
  displayName: 'Huntress',
  fixHref: '/integrations#huntress',
  verdict: huntressHealth,
});

export const huntressSource = huntress.source;
export const huntressObservation = huntress.toObservation;
