import { Hono } from 'hono';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext } from '../../db';
import { clientAiPromptTemplates } from '../../db/schema/clientAi';
import { organizations } from '../../db/schema/orgs';
import { isClientHost } from '../../services/clientAiHosts';
import { defaultTemplatesForHost } from '../../services/clientAiDefaultTemplates';
import {
  clientAiAuthMiddleware,
  requireClientAiEnabledMiddleware,
} from '../../middleware/clientAiAuth';

/**
 * AI for Office — client-facing template list (spec §10/§11). Consumed by the
 * Plan-5 add-in's empty-chat template picker. Response shape is PINNED:
 * a bare JSON array of { id, name, description, category, body }.
 *
 * RLS subtlety (Plan-4 decision 4): clientAiAuthMiddleware opens an
 * org-scoped DB context with accessiblePartnerIds: [], under which
 * partner-wide template rows (org_id NULL, dual-axis policy) are INVISIBLE —
 * breeze_has_partner_access([]) is always false. And withDbAccessContext is a
 * no-op when a context is already open (db/index.ts:103-105). So:
 *   1. Read the org's partner_id INSIDE the middleware context (the org's own
 *      row is readable: organizations is id-keyed shape 2).
 *   2. runOutsideDbContext + a fresh context that adds ONLY the org's own
 *      partner to the partner axis, for the single template SELECT, with an
 *      explicit WHERE (org row OR own-partner row) layered on top of RLS.
 * This grants the client principal the partner axis for exactly one read-only
 * statement — it does NOT broaden the middleware context. The inner context
 * briefly uses a second pooled connection while the outer request transaction
 * is open; both are short reads (#1105 concerns long holds, not this).
 */

export const clientAiTemplateRoutes = new Hono();

clientAiTemplateRoutes.get(
  '/templates',
  clientAiAuthMiddleware,
  requireClientAiEnabledMiddleware,
  async (c) => {
    const auth = c.get('clientAiAuth');

    const [org] = await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, auth.orgId))
      .limit(1);
    const partnerId = org?.partnerId ?? null;

    const orgCondition = eq(clientAiPromptTemplates.orgId, auth.orgId);
    const tenantWhere = partnerId
      ? or(orgCondition, eq(clientAiPromptTemplates.partnerId, partnerId))
      : orgCondition;

    // App targeting: a template with hosts = NULL shows everywhere; otherwise
    // only when this pane's host is in the list. Unknown/absent host param ⇒ no
    // host filter (back-compat with a pane that doesn't send one).
    const hostParam = c.req.query('host');
    const host = hostParam && isClientHost(hostParam) ? hostParam : null;
    const where = host
      ? and(
          tenantWhere,
          sql`(${clientAiPromptTemplates.hosts} IS NULL OR ${host} = ANY(${clientAiPromptTemplates.hosts}))`,
        )
      : tenantWhere;

    const rows = await runOutsideDbContext(() =>
      withDbAccessContext(
        {
          scope: 'organization',
          orgId: auth.orgId,
          accessibleOrgIds: [auth.orgId],
          accessiblePartnerIds: partnerId ? [partnerId] : [],
          userId: null,
        },
        () =>
          db
            .select({
              id: clientAiPromptTemplates.id,
              name: clientAiPromptTemplates.name,
              description: clientAiPromptTemplates.description,
              category: clientAiPromptTemplates.category,
              promptBody: clientAiPromptTemplates.promptBody,
            })
            .from(clientAiPromptTemplates)
            .where(where)
            .orderBy(asc(clientAiPromptTemplates.name))
      )
    );

    const custom = rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      category: r.category,
      body: r.promptBody,
    }));

    // Built-in starter templates for this host always come along (after the
    // org/partner ones). Only when we know the host — a pane that doesn't send
    // one gets just the custom rows (back-compat).
    const defaults = host ? defaultTemplatesForHost(host) : [];

    return c.json([...custom, ...defaults]);
  }
);
