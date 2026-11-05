/**
 * Tool Catalog W05 (#5220), plan Task A6 / Decision 5 — the org a webhook
 * delivery runs in.
 *
 *  - An org flow runs in its own org, which must still be live (status
 *    active/trial, not deleted — `liveOrgCondition`, the gate every flow
 *    trigger applies). A resolver on an org flow is refused at save (PR B
 *    validator); here it fails closed.
 *  - A partner-wide flow reads one value from the body at the trigger's
 *    `orgResolver.path` (own properties only; `__proto__` / `constructor` /
 *    `prototype` are never walked), a string or number of 1..256 characters,
 *    and maps it to an org of the FLOW's partner:
 *      `{ system }`               ⇒ organization_external_links
 *                                    (partner_id, system, external_id);
 *      `{ kind: 'breeze_org_id' }` ⇒ a Breeze org id.
 *    Either way the org must be in the partner-wide fan-out set
 *    (`partnerFanoutOrgCondition`: live, not quick-support, not the holding
 *    org), so a delivery can never start a run in another partner's org or a
 *    suspended one.
 *
 * System context with explicit partner/org predicates (the ingress has no
 * caller). The partner's own status is checked by the ingress after
 * authentication.
 */
import { and, eq } from 'drizzle-orm';
import { FLOW_WEBHOOK_RESOLVER_VALUE_MAX, type FlowWebhookOrgResolver } from '@breeze/shared';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { organizationExternalLinks } from '../../../db/schema/orgExternalLinks';
import { organizations } from '../../../db/schema/orgs';
import { liveOrgCondition, partnerFanoutOrgCondition } from '../../partnerFanoutOrgs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export type WebhookOrgResolution = { ok: true; orgId: string; value: string | null } | { ok: false; value: string | null };

function inSystem<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, 'flows.webhook.resolveOrg'));
}

/** The resolver value at `body.<a>.<b>…`, or null when absent, inherited, non-scalar, empty or over 256 chars. */
export function readResolverValue(path: string, body: Record<string, unknown>): string | null {
  const segments = path.split('.');
  if (segments[0] !== 'body' || segments.length < 2) return null;
  let cur: unknown = body;
  for (const seg of segments.slice(1)) {
    if (FORBIDDEN_SEGMENTS.has(seg)) return null;
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur, seg)) return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  const value = typeof cur === 'string' ? cur : typeof cur === 'number' && Number.isFinite(cur) ? String(cur) : null;
  if (value === null || value.length === 0 || value.length > FLOW_WEBHOOK_RESOLVER_VALUE_MAX) return null;
  return value;
}

export async function resolveWebhookOrg(
  flow: { orgId: string | null; partnerId: string },
  resolver: FlowWebhookOrgResolver | undefined,
  body: Record<string, unknown>,
): Promise<WebhookOrgResolution> {
  if (flow.orgId) {
    if (resolver) return { ok: false, value: null };
    const orgId = flow.orgId;
    const [org] = await inSystem(() => db
      .select({ orgId: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.id, orgId), eq(organizations.partnerId, flow.partnerId), liveOrgCondition()))
      .limit(1));
    return org ? { ok: true, orgId: org.orgId, value: null } : { ok: false, value: null };
  }

  if (!resolver) return { ok: false, value: null };
  const value = readResolverValue(resolver.path, body);
  if (value === null) return { ok: false, value: null };

  if ('kind' in resolver) {
    if (!UUID_RE.test(value)) return { ok: false, value };
    const [org] = await inSystem(() => db
      .select({ orgId: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.id, value), eq(organizations.partnerId, flow.partnerId), partnerFanoutOrgCondition()))
      .limit(1));
    return org ? { ok: true, orgId: org.orgId, value } : { ok: false, value };
  }

  const system = resolver.system;
  const [link] = await inSystem(() => db
    .select({ orgId: organizations.id })
    .from(organizationExternalLinks)
    .innerJoin(organizations, eq(organizations.id, organizationExternalLinks.orgId))
    .where(and(
      eq(organizationExternalLinks.partnerId, flow.partnerId),
      eq(organizationExternalLinks.system, system),
      eq(organizationExternalLinks.externalId, value),
      eq(organizations.partnerId, flow.partnerId),
      partnerFanoutOrgCondition(),
    ))
    .limit(1));
  return link ? { ok: true, orgId: link.orgId, value } : { ok: false, value };
}
