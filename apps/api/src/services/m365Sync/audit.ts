import type { M365SyncDomain } from '@breeze/shared/m365';
import { requestLikeFromSnapshot, writeAuditEvent } from '../auditEvents';
import type { M365SyncRunResult } from './types';

/**
 * One audit event per sync-domain run (spec §7). Details are a fixed allowlist
 * of SHAPE and OUTCOME metadata — never a Graph item, a UPN, a device name, or
 * an error string that could carry row content (spec §8: `last_error` is a
 * sanitized code, and this event carries even less).
 *
 * Fire-and-forget: writeAuditEvent opens its own runOutsideDbContext + system
 * context, so this is safe to call immediately after the completion
 * transaction commits and can never roll it back.
 */
export function recordM365SyncRunEvent(input: {
  orgId: string;
  connectionId: string;
  domain: M365SyncDomain;
  generation: number;
  outcome: M365SyncRunResult;
  correlationId: string;
  truncated: boolean;
  inserted: number;
  updated: number;
  stale: number;
  unchanged: number;
}): void {
  writeAuditEvent(requestLikeFromSnapshot({}), {
    orgId: input.orgId,
    action: 'm365.sync.run',
    resourceType: 'm365_connection',
    resourceId: input.connectionId,
    details: {
      domain: input.domain,
      generation: input.generation,
      outcome: input.outcome,
      truncated: input.truncated,
      inserted: input.inserted,
      updated: input.updated,
      stale: input.stale,
      unchanged: input.unchanged,
      correlationId: input.correlationId,
    },
    result: input.outcome === 'success' || input.outcome === 'partial' ? 'success' : 'failure',
    actorType: 'system',
  });
}
