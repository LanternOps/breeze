/**
 * `manage_tenant_variables` (full-control W13, #6783, PR B): the AI twin of
 * the tenant-variable routes (routes/tenantVariables.ts, #3409) through the
 * same service (services/tenantVariables.ts).
 *
 * Classes (W13 plan, fact 11, quorum QW6):
 *  - `list` t1 — a secret row's value is never returned (`toApiTenantVariable`
 *    returns null for it), and a device-bound session cannot read org-wide
 *    configuration;
 *  - `create` / `update` / `delete` supervised and AGENT_HUMAN_ONLY_ACTIONS:
 *    values are substituted into every script dispatched to the org's devices
 *    (`{{var.<key>}}`, tenantVariableResolution.ts), and an org row shadows the
 *    partner-wide row of the same key.
 *
 * Stronger than REST:
 *  - W13-D7: the tool never creates, reads or edits a SECRET value. `create`
 *    has no `isSecret` input (always a plain variable); `update` refuses a
 *    secret row. A secret typed into chat would persist in the transcript and
 *    the action-intent input. Deleting a secret row is allowed (it reveals
 *    nothing), and no output, audit row or log line carries a value.
 *  - W13-D13: org writes need `canMutateOrgWideGovernance` (a site- or
 *    device-restricted session cannot change org-wide config); a partner-wide
 *    `create` needs `canManagePartnerWidePolicies` (the service's own gate);
 *    an EXISTING partner-wide row is never updated or deleted by the tool
 *    (the W12-D10 pattern).
 * The handler runs at release, so the secret / partner-wide checks are
 * re-made against the row as it is when the approved change executes.
 */
import { and, eq } from 'drizzle-orm';
import { createTenantVariableSchema, updateTenantVariableSchema } from '@breeze/shared';
import { db } from '../db';
import { tenantVariables, type TenantVariableRow } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { mfaGatedToolError } from './aiToolMfaGate';
import {
  TenantVariableError, createTenantVariable, deleteTenantVariable, listTenantVariables, tenantVariableOwnerScope,
  tenantVariableReadCondition, toApiTenantVariable, updateTenantVariable,
} from './tenantVariables';
import { TENANT_VARIABLE_ACTIONS } from './aiToolSchemasDeviceOps';
import {
  auditToolWrite, bounded, deviceBoundDenied, jsonError, notFound, orgWideWriteDenied, thrown,
} from './aiToolsSoftwareShared';

type Action = (typeof TENANT_VARIABLE_ACTIONS)[number];

/** Most variables one list returns (an owner holds at most 200). */
export const MAX_TENANT_VARIABLES_LISTED = 200;

/** The audit details REST writes: the binding, never the value. */
function auditDetails(row: TenantVariableRow): Record<string, unknown> {
  return {
    variableId: row.id,
    key: row.key,
    ownerScope: tenantVariableOwnerScope(row),
    isSecret: row.isSecret,
    version: row.version,
    partnerWide: row.orgId === null,
  };
}

function serviceError(err: unknown): string | null {
  if (!(err instanceof TenantVariableError)) return null;
  const code = err.status === 404 ? 'NOT_FOUND' : err.status === 403 ? 'ACCESS_DENIED' : err.status === 409 ? 'CONFLICT' : 'VALIDATION_ERROR';
  return jsonError(err.message, err.code ?? code);
}

async function readableRow(id: string, auth: AuthContext): Promise<TenantVariableRow | null> {
  const access = tenantVariableReadCondition(auth);
  const [row] = await db.select().from(tenantVariables)
    .where(access ? and(eq(tenantVariables.id, id), access) : eq(tenantVariables.id, id))
    .limit(1);
  return row ?? null;
}

export function registerTenantVariableTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_tenant_variables', {
    tier: 1,
    domain: 'scripts',
    searchHint: 'tenant variables substituted into scripts as {{var.key}}: list, add, change or delete (never secrets)',
    definition: {
      name: 'manage_tenant_variables',
      description: 'Actions: list, create, update, delete the {{var.<key>}} values scripts receive. Secret values are never shown or set here. Writes need approval; partner-wide rows are changed in the web app.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...TENANT_VARIABLE_ACTIONS], description: 'The action to perform' },
          variableId: { type: 'string', description: 'update / delete: variable UUID' },
          orgId: { type: 'string', description: 'list: one org plus the partner-wide rows it inherits; create: owning org' },
          scope: { type: 'string', enum: ['partner', 'org', 'all'], description: 'list: which rows (default all)' },
          ownerScope: { type: 'string', enum: ['organization', 'partner'], description: 'create: organization (default) or partner-wide' },
          key: { type: 'string', description: 'create: variable key (letters, digits, underscore)' },
          value: { type: 'string', description: 'create / update: the plain (non-secret) value' },
          description: { type: ['string', 'null'], description: 'create / update' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!TENANT_VARIABLE_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      try {
        if (action === 'list') {
          const bound = deviceBoundDenied(auth, 'Tenant variables');
          if (bound) return bound;
          const orgId = typeof input.orgId === 'string' ? input.orgId : undefined;
          if (orgId && !auth.canAccessOrg(orgId)) return notFound('Organization');
          const scope = (typeof input.scope === 'string' ? input.scope : 'all') as 'partner' | 'org' | 'all';
          const rows = await listTenantVariables(auth, { orgId, scope });
          return bounded({
            variables: rows.slice(0, MAX_TENANT_VARIABLES_LISTED).map((v) => ({
              id: v.id, key: v.key, isSecret: v.isSecret,
              // W13-D7: a secret's value is never returned (the service already nulls it; belt and braces).
              value: v.isSecret ? null : v.value,
              description: v.description, ownerScope: v.ownerScope, orgId: v.orgId, orgName: v.orgName, version: v.version,
            })),
            total: rows.length,
          });
        }

        const mfa = mfaGatedToolError('manage_tenant_variables', action, auth);
        if (mfa) return mfa;
        const denied = orgWideWriteDenied(auth, 'A tenant variable');
        if (denied) return denied;

        if (action === 'create') {
          const parsed = createTenantVariableSchema.safeParse({
            ownerScope: input.ownerScope ?? 'organization',
            ...(typeof input.orgId === 'string' ? { orgId: input.orgId } : {}),
            key: input.key,
            value: input.value,
            ...(input.description !== undefined ? { description: input.description } : {}),
            isSecret: false,
          });
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input', 'VALIDATION_ERROR');
          const row = await createTenantVariable(auth, parsed.data);
          auditToolWrite(auth, {
            orgId: row.orgId, partnerId: row.partnerId, action: 'tenant_variable.create', resourceType: 'tenant_variable',
            resourceId: row.id, resourceName: row.key, details: auditDetails(row),
          });
          return bounded({ variable: toApiTenantVariable(row) });
        }

        if (typeof input.variableId !== 'string') return jsonError('variableId is required', 'VALIDATION_ERROR');
        const existing = await readableRow(input.variableId, auth);
        if (!existing) return notFound('Tenant variable');
        if (existing.orgId === null) {
          return jsonError('Partner-wide variables are changed in the web app', 'ACCESS_DENIED');
        }

        if (action === 'update') {
          if (existing.isSecret) {
            return jsonError('Secret variables are changed in the web app; their values never pass through the AI assistant', 'ACCESS_DENIED');
          }
          const parsed = updateTenantVariableSchema.safeParse({
            ...(input.value !== undefined ? { value: input.value } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
          });
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid input', 'VALIDATION_ERROR');
          if (Object.keys(parsed.data).length === 0) return jsonError('Nothing to update (value or description)', 'VALIDATION_ERROR');
          const row = await updateTenantVariable(auth, existing.id, parsed.data);
          auditToolWrite(auth, {
            orgId: row.orgId, action: 'tenant_variable.update', resourceType: 'tenant_variable',
            resourceId: row.id, resourceName: row.key,
            details: { ...auditDetails(row), valueChanged: parsed.data.value !== undefined },
          });
          return bounded({ variable: toApiTenantVariable(row) });
        }

        const row = await deleteTenantVariable(auth, existing.id);
        auditToolWrite(auth, {
          orgId: row.orgId, action: 'tenant_variable.delete', resourceType: 'tenant_variable',
          resourceId: row.id, resourceName: row.key, details: auditDetails(row),
        });
        return bounded({ deleted: true, variableId: row.id, key: row.key });
      } catch (error) {
        return serviceError(error) ?? thrown('manage_tenant_variables', error);
      }
    },
  });
}
