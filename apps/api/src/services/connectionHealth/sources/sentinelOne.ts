import { s1Integrations } from '../../../db/schema';
import { sentinelOneHealth } from '../../integrationStates';
import { partnerSyncSource } from './partnerSync';

// Agent sync every 15 minutes, threat sync every 5 (jobs/s1Sync.ts); both
// write these columns and every failed attempt writes 'error' (redacted).
const sentinelOne = partnerSyncSource({
  kind: 'sentinelone',
  table: s1Integrations,
  tableName: 's1_integrations',
  intervalMinutes: 15,
  failedValue: 'error',
  displayName: 'SentinelOne',
  fixHref: '/integrations#sentinelone',
  verdict: sentinelOneHealth,
});

export const sentinelOneSource = sentinelOne.source;
export const sentinelOneObservation = sentinelOne.toObservation;
