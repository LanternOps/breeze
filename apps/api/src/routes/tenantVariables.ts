import { Hono } from 'hono';
import { z } from 'zod';
import { createTenantVariableSchema, updateTenantVariableSchema } from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS } from '../services/permissions';
import {
  createTenantVariable,
  deleteTenantVariable,
  listTenantVariables,
  TenantVariableError,
  tenantVariableOwnerScope,
  toApiTenantVariable,
  updateTenantVariable
} from '../services/tenantVariables';
import type { TenantVariableRow } from '../db/schema';

/**
 * Tenant variables CRUD (#3409 PR 1).
 *
 * Root-mounted router (absolute paths): authMiddleware must lead EACH route's
 * middleware chain — a router-level .use('*') here would attach auth to every
 * sibling api route, including public ones (the #1383 footgun documented in
 * ticketResponseTemplates.ts / externalServices.ts).
 */
export const tenantVariableRoutes = new Hono();

const requireVariablesRead = requirePermission(PERMISSIONS.VARIABLES_READ.resource, PERMISSIONS.VARIABLES_READ.action);
const requireVariablesManage = requirePermission(
  PERMISSIONS.VARIABLES_MANAGE.resource,
  PERMISSIONS.VARIABLES_MANAGE.action
);
const scopes = requireScope('organization', 'partner', 'system');

const listQuerySchema = z.object({ orgId: z.string().guid().optional() });
const idParamSchema = z.object({ id: z.string().guid() });

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof TenantVariableError) {
    return c.json({ error: err.message }, err.status);
  }
  throw err;
}

/** Audit details carry the binding, NEVER the value — not even for non-secret variables. */
function auditDetails(row: TenantVariableRow) {
  return {
    variableId: row.id,
    key: row.key,
    ownerScope: tenantVariableOwnerScope(row),
    isSecret: row.isSecret,
    version: row.version,
    partnerWide: row.orgId === null
  };
}

tenantVariableRoutes.get(
  '/tenant-variables',
  authMiddleware,
  scopes,
  requireVariablesRead,
  zValidator('query', listQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { orgId } = c.req.valid('query');

    // Check access BEFORE fetching: this must not leak which orgs exist by
    // returning an empty list for a reachable org and an error for others.
    if (orgId && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const data = await listTenantVariables(auth, orgId ? { orgId } : {});
    return c.json({ data });
  }
);

tenantVariableRoutes.post(
  '/tenant-variables',
  authMiddleware,
  scopes,
  requireVariablesManage,
  requireMfa(),
  zValidator('json', createTenantVariableSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    let row: TenantVariableRow;
    try {
      row = await createTenantVariable(auth, payload);
    } catch (err) {
      return handleServiceError(c, err);
    }

    writeRouteAudit(c, {
      orgId: row.orgId,
      action: 'tenant_variable.create',
      resourceType: 'tenant_variable',
      resourceId: row.id,
      resourceName: row.key,
      details: auditDetails(row)
    });

    return c.json({ data: toApiTenantVariable(row) }, 201);
  }
);

tenantVariableRoutes.put(
  '/tenant-variables/:id',
  authMiddleware,
  scopes,
  requireVariablesManage,
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', updateTenantVariableSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    let row: TenantVariableRow;
    try {
      row = await updateTenantVariable(auth, id, payload);
    } catch (err) {
      return handleServiceError(c, err);
    }

    writeRouteAudit(c, {
      orgId: row.orgId,
      action: 'tenant_variable.update',
      resourceType: 'tenant_variable',
      resourceId: row.id,
      resourceName: row.key,
      // valueChanged (not the value) is what an auditor needs to correlate a
      // rotation with a later dispatch.
      details: { ...auditDetails(row), valueChanged: payload.value !== undefined }
    });

    return c.json({ data: toApiTenantVariable(row) });
  }
);

tenantVariableRoutes.delete(
  '/tenant-variables/:id',
  authMiddleware,
  scopes,
  requireVariablesManage,
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    let row: TenantVariableRow;
    try {
      row = await deleteTenantVariable(auth, id);
    } catch (err) {
      return handleServiceError(c, err);
    }

    writeRouteAudit(c, {
      orgId: row.orgId,
      action: 'tenant_variable.delete',
      resourceType: 'tenant_variable',
      resourceId: row.id,
      resourceName: row.key,
      details: auditDetails(row)
    });

    return c.json({ success: true });
  }
);
