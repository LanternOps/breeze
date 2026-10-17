import { pax8Integrations } from '../../../db/schema';
import { pax8Health } from '../../integrationStates';
import { partnerSyncSource } from './partnerSync';

// Pax8 syncs nightly (and on save), and writes 'failed', not 'error'
// (services/pax8SyncService.ts). Hourly observation matches the signal.
const pax8 = partnerSyncSource({
  kind: 'pax8',
  table: pax8Integrations,
  tableName: 'pax8_integrations',
  intervalMinutes: 60,
  failedValue: 'failed',
  syncIntervalMinutes: 1440,
  withTimezone: true,
  displayName: 'Pax8',
  fixHref: '/integrations#pax8',
  verdict: pax8Health,
});

export const pax8Source = pax8.source;
export const pax8Observation = pax8.toObservation;
