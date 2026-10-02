/**
 * Which optional ledger sources this build records (W11 #7609). W09 adds
 * ai_invocations.failover_hop / failover_from_offering_id and W05 adds
 * ai_sessions.continued_from_session_id. The quality view reads them when
 * present and reports null when not, so it never names a missing column.
 *
 * Read from the Drizzle schema, not information_schema: autoMigrate applies
 * every migration this build ships before the API serves, and
 * `pnpm db:check-drift` keeps schema and migrations equal, so the schema is
 * the build's truth and the answer is free and deterministic.
 */
import { getTableColumns } from 'drizzle-orm';
import { aiInvocations, aiSessions } from '../../db/schema';

export interface QualitySources {
  failover: boolean;
  continuation: boolean;
}

export function detectQualitySources(): QualitySources {
  const inv = getTableColumns(aiInvocations) as Record<string, unknown>;
  const sess = getTableColumns(aiSessions) as Record<string, unknown>;
  return {
    failover: 'failoverHop' in inv && 'failoverFromOfferingId' in inv,
    continuation: 'continuedFromSessionId' in sess,
  };
}
