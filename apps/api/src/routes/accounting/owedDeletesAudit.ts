import { writeRouteAudit, type AuthContext } from '../../services/auditEvents';
import type { OwedPaymentDeletes } from '../../services/accounting/accountingConnectionService';
import type { AccountingProviderId } from '../../services/accounting/types';

/**
 * The audit half of the owed-delete contract (review wave 2, finding 3): a
 * connection delete is never blocked, but the payment deletes its mappings
 * still owed die with it (ON DELETE CASCADE), and the remote ids are the only
 * thing that lets a human find those Payments afterwards. The service layer
 * already warned and raised Sentry. Written only when something was owed, so a
 * plain delete makes no noise.
 *
 * `resourceId` is the CONNECTION id on every path, so the trail can be joined.
 */
export function auditOwedDeletesDiscarded(c: AuthContext, input: {
  provider: AccountingProviderId;
  connectionId: string;
  reason: 'disconnect' | 'tenant_selection_cancelled';
  owed: OwedPaymentDeletes;
}): void {
  if (input.owed.count === 0) return;
  writeRouteAudit(c, {
    orgId: null,
    action: 'accounting.connection.owed_deletes_discarded',
    resourceType: 'accounting_connection',
    resourceId: input.connectionId,
    result: 'failure',
    details: {
      provider: input.provider,
      reason: input.reason,
      count: input.owed.count,
      remoteEntityIds: input.owed.remoteEntityIds,
    },
  });
}
