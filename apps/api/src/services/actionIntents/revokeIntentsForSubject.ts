/**
 * Caller verification W05 (#6354): after a "This is not me" rejection, cancel
 * every undispatched protected M365 identity intent that targets one of the
 * subject's bindings, and link the outcomes to the security incident.
 *
 * Runs inside the rejection transaction (joins the ambient system context).
 * Returns the three id lists the incident summary reports: intents this call
 * cancelled, intents already executing (cannot be stopped), and intents whose
 * dispatch had already started before the rejection (confirm in Entra).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { aiOperatorOperations } from '../../db/schema/aiOperatorTasks';
import { isTaskLinkedIntent, markOperationCancelled } from '../aiOperator/operationService';
import { publishIntentTerminalOutbox } from '../aiOperator/taskOutbox';
import { linkCallerIncidentIntents } from '../callerVerification/incidentLinks';

export const PROTECTED_M365_INTENT_ACTIONS = ['m365_reset_password', 'm365_disable_user'] as const;

export async function revokeIntentsForSubject(input: {
  orgId: string;
  bindingIds: string[];
  verificationId: string;
}): Promise<{ cancelled: string[]; alreadyExecuting: string[]; alreadyDispatched: string[] }> {
  const result = {
    cancelled: [] as string[],
    alreadyExecuting: [] as string[],
    alreadyDispatched: [] as string[],
  };
  if (!input.bindingIds.length) return result;

  return withSystemDbAccessContext(async () => {
    const ids = sql.join(input.bindingIds.map((id) => sql`${id}::uuid`), sql`, `);
    // Only intents with a pinned target can match (NULL = NULL is never true).
    const candidates = await db
      .select()
      .from(actionIntents)
      .where(
        and(
          eq(actionIntents.orgId, input.orgId),
          inArray(actionIntents.actionName, [...PROTECTED_M365_INTENT_ACTIONS]),
          sql`(
            EXISTS (SELECT 1 FROM caller_verification_subject_bindings b
              WHERE b.org_id = ${actionIntents.orgId} AND b.id IN (${ids})
                AND b.entra_tenant_id = ${actionIntents.targetEntraTenantId}
                AND b.entra_oid = ${actionIntents.targetEntraOid})
            OR EXISTS (SELECT 1 FROM caller_verifications g
              WHERE g.org_id = ${actionIntents.orgId} AND g.requester_binding_id IN (${ids})
                AND (g.consumed_intent_ref = ${actionIntents.id}
                  OR (g.consumed_at IS NULL AND g.status IN ('verified', 'revoked')
                    AND g.target_entra_tenant_id = ${actionIntents.targetEntraTenantId}
                    AND g.target_entra_oid = ${actionIntents.targetEntraOid}
                    AND g.action_scope::text IN ('any', CASE WHEN ${actionIntents.actionName} = 'm365_disable_user'
                      THEN 'disable_user' ELSE 'reset_password' END))))
          )`,
        ),
      );

    for (const intent of candidates) {
      const taskLinked = isTaskLinkedIntent(intent);
      // LOCK ORDER: operation before intent (matches cancelActionIntent and
      // claimTaskLinkedIntentForDispatch) so this cannot AB-BA with a release.
      if (taskLinked) {
        await db
          .select({ id: aiOperatorOperations.id })
          .from(aiOperatorOperations)
          .where(eq(aiOperatorOperations.intentId, intent.id))
          .for('update')
          .limit(1);
      }
      const won = await db
        .update(actionIntents)
        .set({
          status: 'cancelled',
          result: { actor: 'system:caller_verification', verificationId: input.verificationId },
        })
        .where(
          and(
            eq(actionIntents.id, intent.id),
            eq(actionIntents.orgId, input.orgId),
            inArray(actionIntents.status, ['pending_approval', 'approved']),
          ),
        )
        .returning({ id: actionIntents.id });

      if (won.length) {
        if (taskLinked) await markOperationCancelled(db, intent.id);
        await publishIntentTerminalOutbox(
          db,
          { id: intent.id, orgId: intent.orgId, taskId: intent.taskId },
          'intent_cancelled',
        );
        result.cancelled.push(intent.id);
        continue;
      }
      const [live] = await db
        .select({ status: actionIntents.status, dispatchStartedAt: actionIntents.dispatchStartedAt })
        .from(actionIntents)
        .where(eq(actionIntents.id, intent.id))
        .limit(1);
      if (live?.dispatchStartedAt) result.alreadyDispatched.push(intent.id);
      else if (live?.status === 'executing') result.alreadyExecuting.push(intent.id);
    }

    await linkCallerIncidentIntents(
      input.orgId,
      input.verificationId,
      candidates.map((i) => i.id),
    );
    return result;
  }, 'callerVerification.revokeIntentsForSubject');
}
