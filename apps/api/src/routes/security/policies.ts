import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '../../db';
import { securityPolicies } from '../../db/schema';
import { requireScope } from '../../middleware/auth';
import {
  listPoliciesQuerySchema,
  createPolicySchema,
  updatePolicySchema,
  policyIdParamSchema
} from './schemas';
import { getPolicyOrgId } from './helpers';

export const policiesRoutes = new Hono();

policiesRoutes.get(
  '/policies',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listPoliciesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const conditions = [];
    const orgCondition = auth.orgCondition(securityPolicies.orgId);
    if (orgCondition) conditions.push(orgCondition);

    const rows = await db
      .select()
      .from(securityPolicies)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(securityPolicies.createdAt));

    let policies = rows.map((row) => {
      const settings = (row.settings ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        orgId: row.orgId,
        name: row.name,
        description: typeof settings.description === 'string' ? settings.description : undefined,
        providerId: typeof settings.providerId === 'string' ? settings.providerId : undefined,
        scanSchedule: (typeof settings.scanSchedule === 'string' ? settings.scanSchedule : 'weekly') as 'daily' | 'weekly' | 'monthly' | 'manual',
        realTimeProtection: typeof settings.realTimeProtection === 'boolean' ? settings.realTimeProtection : true,
        autoQuarantine: typeof settings.autoQuarantine === 'boolean' ? settings.autoQuarantine : true,
        severityThreshold: (typeof settings.severityThreshold === 'string' ? settings.severityThreshold : 'medium') as 'low' | 'medium' | 'high' | 'critical',
        exclusions: Array.isArray(settings.exclusions) ? settings.exclusions.filter((value): value is string => typeof value === 'string') : [],
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.createdAt.toISOString()
      };
    });

    if (query.providerId) {
      policies = policies.filter((policy) => policy.providerId === query.providerId);
    }

    if (query.scanSchedule) {
      policies = policies.filter((policy) => policy.scanSchedule === query.scanSchedule);
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      policies = policies.filter((policy) => {
        return (
          policy.name.toLowerCase().includes(term) ||
          policy.description?.toLowerCase().includes(term)
        );
      });
    }

    return c.json({ data: policies });
  }
);

policiesRoutes.post(
  '/policies',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createPolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');
    const orgId = getPolicyOrgId(auth);

    if (!orgId) {
      return c.json({ error: 'Unable to determine target organization for policy creation' }, 400);
    }

    const [policy] = await db
      .insert(securityPolicies)
      .values({
        orgId,
        name: payload.name,
        settings: {
          description: payload.description,
          providerId: payload.providerId,
          scanSchedule: payload.scanSchedule,
          realTimeProtection: payload.realTimeProtection,
          autoQuarantine: payload.autoQuarantine,
          severityThreshold: payload.severityThreshold,
          exclusions: payload.exclusions
        }
      })
      .returning();
    if (!policy) {
      return c.json({ error: 'Failed to create policy' }, 500);
    }

    return c.json({ data: {
      id: policy.id,
      name: policy.name,
      description: payload.description,
      providerId: payload.providerId,
      scanSchedule: payload.scanSchedule,
      realTimeProtection: payload.realTimeProtection,
      autoQuarantine: payload.autoQuarantine,
      severityThreshold: payload.severityThreshold,
      exclusions: payload.exclusions,
      createdAt: policy.createdAt.toISOString(),
      updatedAt: policy.createdAt.toISOString()
    } }, 201);
  }
);

policiesRoutes.put(
  '/policies/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdParamSchema),
  zValidator('json', updatePolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const conditions = [eq(securityPolicies.id, id)];
    const orgCondition = auth.orgCondition(securityPolicies.orgId);
    if (orgCondition) conditions.push(orgCondition);

    const [existing] = await db
      .select()
      .from(securityPolicies)
      .where(and(...conditions))
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    const existingSettings = (existing.settings ?? {}) as Record<string, unknown>;
    const nextSettings = {
      ...existingSettings,
      ...payload
    };

    const [updated] = await db
      .update(securityPolicies)
      .set({
        name: payload.name ?? existing.name,
        settings: nextSettings
      })
      .where(eq(securityPolicies.id, id))
      .returning();
    if (!updated) {
      return c.json({ error: 'Failed to update policy' }, 500);
    }

    return c.json({ data: {
      id: updated.id,
      name: updated.name,
      description: typeof nextSettings.description === 'string' ? nextSettings.description : undefined,
      providerId: typeof nextSettings.providerId === 'string' ? nextSettings.providerId : undefined,
      scanSchedule: (typeof nextSettings.scanSchedule === 'string' ? nextSettings.scanSchedule : 'weekly') as 'daily' | 'weekly' | 'monthly' | 'manual',
      realTimeProtection: typeof nextSettings.realTimeProtection === 'boolean' ? nextSettings.realTimeProtection : true,
      autoQuarantine: typeof nextSettings.autoQuarantine === 'boolean' ? nextSettings.autoQuarantine : true,
      severityThreshold: (typeof nextSettings.severityThreshold === 'string' ? nextSettings.severityThreshold : 'medium') as 'low' | 'medium' | 'high' | 'critical',
      exclusions: Array.isArray(nextSettings.exclusions) ? nextSettings.exclusions.filter((value): value is string => typeof value === 'string') : [],
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.createdAt.toISOString()
    } });
  }
);
