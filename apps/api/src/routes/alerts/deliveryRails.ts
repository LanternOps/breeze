// routes/alerts/deliveryRails.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { notificationChannels, notificationRoutingRules, escalationPolicies } from '../../db/schema';
import { requirePermission, requireScope } from '../../middleware/auth';
import { zValidator } from '../../lib/validation';
import { PERMISSIONS } from '../../services/permissions';
import { partnerIdForOrg } from '../../services/delivery/railOwnership';
import { readInheritedRails } from '../../services/delivery/inheritedRails';
import { listEscalationUsers } from '../../services/delivery/escalationExecution';
import { redactNotificationChannelConfig } from '../../services/notificationChannelSecrets';
import { selectNotificationChannelsWithConfig } from '../../services/notificationChannelConfig';
import { resolveWriteOrgId } from './helpers';
import { canAccessRoutingSites, routingSiteIds } from './routing';
const querySchema = z.object({ rail: z.enum(['channels','routing','escalation','users']),
  orgId: z.string().guid().optional(), ownerScope: z.enum(['organization','partner']).optional() }).strict();
export const deliveryRailsRoutes = new Hono();
deliveryRailsRoutes.get('/delivery/rails', requireScope('organization','partner','system'),
  requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action),
  zValidator('query', querySchema), async c => {
    try {
      const auth = c.get('auth'), query = c.req.valid('query');
      const partnerOnly = query.ownerScope === 'partner' || (auth.scope === 'partner' && !query.orgId);
      if (query.ownerScope === 'partner' && query.rail !== 'users') return c.json({ error: 'ownerScope applies to users only' }, 400);
      if (partnerOnly && (auth.scope === 'organization' || !auth.partnerId)) return c.json({ error: 'Partner scope required' }, 403);
      const resolved: ReturnType<typeof resolveWriteOrgId> = partnerOnly ? {} : resolveWriteOrgId(auth, query.orgId);
      if (resolved.error) return c.json({ error: resolved.error }, resolved.status ?? 400);
      const orgId = resolved.orgId ?? null;
      const partnerId = orgId ? await partnerIdForOrg(orgId) : auth.partnerId;
      if (orgId && !partnerId) return c.json({ error: 'Organization not found' }, 404);
      const owner = { orgId, partnerId: orgId ? null : partnerId ?? null };
      const axis = (table: typeof notificationRoutingRules | typeof notificationChannels | typeof escalationPolicies) => orgId
        ? eq(table.orgId, orgId)
        : and(isNull(table.orgId), eq(table.partnerId, partnerId!));
      if (query.rail === 'users') return c.json({ data: await listEscalationUsers(owner, undefined, { includePartnerUsers: auth.scope !== 'organization' }) });
      const inherited = () => orgId && partnerId
        ? readInheritedRails(query.rail as 'channels' | 'routing' | 'escalation', { orgId, partnerId, allowedSiteIds: auth.allowedSiteIds }, db)
        : Promise.resolve([]);
      if (query.rail === 'routing') {
        const rows = await db.select().from(notificationRoutingRules)
          .where(axis(notificationRoutingRules)).orderBy(asc(notificationRoutingRules.isDefault), asc(notificationRoutingRules.priority));
        const visible = await Promise.all(rows.map(async row =>
          await canAccessRoutingSites(auth, { orgId: row.orgId, partnerId: row.partnerId }, routingSiteIds(row.conditions), false)
            ? row : null));
        return c.json({ data: [...visible.filter(row => row !== null), ...await inherited()] });
      }
      if (query.rail === 'escalation') {
        const editable = await db.select().from(escalationPolicies).where(axis(escalationPolicies)).orderBy(asc(escalationPolicies.name));
        return c.json({ data: [...editable, ...await inherited()] });
      }
      const rows = await selectNotificationChannelsWithConfig(axis(notificationChannels), {
        orderBy: [asc(notificationChannels.name)],
      });
      return c.json({
        data: rows.map(row => ({ ...row,
          config: redactNotificationChannelConfig(row.type, row.config ?? {}) })),
        inherited: await inherited(),
      });
    } catch (error) {
      console.error('[DeliveryRails] Read failed', error);
      return c.json({ error: 'Failed to load delivery settings' }, 500);
    }
  });
