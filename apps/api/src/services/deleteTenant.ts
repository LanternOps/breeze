/**
 * delete_tenant tool (Task 7.1, MCP Agent-Deployable Setup plan)
 *
 * Tier 3+ destructive tool. Flag-independent — registered into the standard
 * authed aiTools registry, available to MCP agents and the in-app assistant
 * regardless of `IS_HOSTED`.
 *
 * Safety rails:
 *   1. `tenant_id` MUST equal the API key's partnerId → cross-tenant deletion
 *      is physically impossible through this tool.
 *   2. `confirmation_phrase` MUST exactly equal (case-insensitive, trimmed)
 *      `delete <partner_name> permanently`. The agent has to know the tenant's
 *      name, preventing accidental dispatch.
 *   3. Soft-delete only: sets `partners.deletedAt = now()` and flips
 *      `status = 'churned'`. A 30-day restore window is promised; actual
 *      hard-delete is the responsibility of a future scheduled job.
 *
 * Status enum note: the `partner_status` enum does not include `soft_deleted`.
 * We deliberately reuse the existing `churned` value and rely on `deletedAt`
 * being non-null as the authoritative soft-delete flag, to avoid schema churn.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { partners } from '../db/schema';
import { writeAuditEvent, requestLikeFromSnapshot } from './auditEvents';
import type { AuthContext } from '../middleware/auth';
import type { AiTool, AiToolTier } from './aiTools';

interface DeleteTenantInput {
  tenant_id: string;
  confirmation_phrase: string;
}

/**
 * Coded error for the handler so the MCP dispatch surface can map to clear
 * error payloads. We return a JSON-string error rather than throwing so the
 * AI agent can read the failure reason without hitting the generic
 * "Operation failed" fallback.
 */
function codedError(code: string, message: string): string {
  return JSON.stringify({ error: message, code });
}

export async function runDeleteTenant(
  input: DeleteTenantInput,
  auth: AuthContext,
): Promise<string> {
  if (!auth.partnerId) {
    return codedError(
      'PARTNER_SCOPE_REQUIRED',
      'delete_tenant requires a partner-scoped API key.',
    );
  }

  if (input.tenant_id !== auth.partnerId) {
    return codedError(
      'CROSS_TENANT_FORBIDDEN',
      'Cross-tenant deletion forbidden. This API key can only delete its own tenant.',
    );
  }

  const [partner] = await db
    .select({ id: partners.id, name: partners.name, deletedAt: partners.deletedAt })
    .from(partners)
    .where(eq(partners.id, input.tenant_id))
    .limit(1);

  if (!partner) {
    return codedError('UNKNOWN_TENANT', 'Unknown tenant.');
  }

  if (partner.deletedAt) {
    return codedError(
      'ALREADY_DELETED',
      'Tenant is already soft-deleted. Contact support to restore or hard-delete.',
    );
  }

  const expected = `delete ${partner.name.toLowerCase()} permanently`;
  const supplied = (input.confirmation_phrase ?? '').trim().toLowerCase();
  if (supplied !== expected) {
    return codedError(
      'BAD_CONFIRMATION',
      `confirmation_phrase must equal exactly: "${expected}"`,
    );
  }

  const now = new Date();
  await db
    .update(partners)
    .set({ status: 'churned', deletedAt: now, updatedAt: now })
    .where(eq(partners.id, input.tenant_id));

  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: auth.orgId ?? null,
      actorType: 'api_key',
      actorId: auth.user.id,
      action: 'partner.soft_deleted',
      resourceType: 'partner',
      resourceId: input.tenant_id,
      resourceName: partner.name,
      result: 'success',
      details: {
        tool_name: 'delete_tenant',
        restore_window_days: 30,
      },
    });
  } catch (err) {
    // Audit write is best-effort — never block the soft-delete on audit failure.
    console.error('[delete_tenant] audit write failed', err);
  }

  return JSON.stringify({
    soft_deleted: true,
    tenant_id: input.tenant_id,
    tenant_name: partner.name,
    deleted_at: now.toISOString(),
    restore_window_days: 30,
    message:
      'Tenant soft-deleted. Contact support within 30 days to restore. After 30 days, data is permanently removed.',
  });
}

export function registerDeleteTenantTool(aiTools: Map<string, AiTool>): void {
  aiTools.set('delete_tenant', {
    tier: 3 as AiToolTier,
    definition: {
      name: 'delete_tenant',
      description:
        'Soft-delete this tenant with a 30-day restore window. The confirmation_phrase must exactly equal "delete <tenant_name> permanently" (lowercase, trimmed). Can ONLY delete the tenant this API key belongs to — cross-tenant deletion is blocked. After deletion, all devices, users, and data remain intact for 30 days and can be restored by contacting support. After 30 days, data is permanently removed.',
      input_schema: {
        type: 'object' as const,
        properties: {
          tenant_id: {
            type: 'string',
            format: 'uuid',
            description:
              'UUID of the partner/tenant to soft-delete. MUST equal the partnerId of the API key making the request.',
          },
          confirmation_phrase: {
            type: 'string',
            description:
              'Typed confirmation. MUST exactly equal "delete <tenant_name> permanently" (case-insensitive, trimmed). Prevents accidental deletions.',
          },
        },
        required: ['tenant_id', 'confirmation_phrase'],
      },
    },
    handler: async (input: Record<string, unknown>, auth: AuthContext) => {
      try {
        return await runDeleteTenant(input as unknown as DeleteTenantInput, auth);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        console.error('[delete_tenant]', message, err);
        return JSON.stringify({
          error: 'Operation failed. Check server logs for details.',
        });
      }
    },
  });
}
