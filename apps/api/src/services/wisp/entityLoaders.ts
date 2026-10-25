/**
 * Wisp W08 (feature #9906; w00 A35) — one read per linkable entity kind.
 *
 * Each loader answers "does this object exist inside this partner, and what
 * are its org, site, title and status?" It is the FIRST step of
 * `resolveEntityRef` and decides nothing on its own: the caller's permission,
 * the grant ceiling and the token scope are checked afterwards against the
 * org/site read HERE (never against an org a caller or a stored row claims).
 *
 * Reads run in system context with an explicit partner pin, so the answer is
 * the same from a request, a chat turn or the home aggregate:
 *   - every org-bearing kind inner-joins `organizations` on the row's org and
 *     requires `organizations.partner_id = partnerId`, a live (not deleted)
 *     org, and not a hidden org type (Quick Support / unassigned pool —
 *     `notHiddenOrgType`), so a parked device or another partner's ticket is
 *     `null` exactly like a missing one;
 *   - soft-deleted tickets and organizations are `null`;
 *   - `user` is partner-level: same partner, no org.
 * A `null` result becomes `not_found` (existence-neutral).
 */
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import type { WispEntityKind } from '@breeze/shared';
import { db } from '../../db';
import {
  aiAgentRuns,
  aiOperatorTasks,
  alerts,
  contracts,
  devices,
  invoices,
  organizations,
  quotes,
  sites,
  tickets,
  users,
} from '../../db/schema';
import { notHiddenOrgType } from '../unassignedPool/visibility';
import { inSystemContext } from './grantAuthority';

export type LoadedEntity = {
  /** null only for partner-level kinds (`user`). */
  orgId: string | null;
  /**
   * The row's site: `undefined` = the kind has no site axis; `null` = a
   * site-bearing kind with no site set. A site-restricted ceiling refuses both
   * (an unknown site never widens a restriction).
   */
  siteId?: string | null;
  orgName: string | null;
  /** Untrimmed natural title pieces; `resolveEntityRef` builds and caps the label. */
  title: string;
  status: string | null;
};

/** The org join every org-bearing kind shares: same partner, live, not hidden. */
function orgPin(partnerId: string): SQL {
  return and(eq(organizations.partnerId, partnerId), isNull(organizations.deletedAt), notHiddenOrgType()) as SQL;
}

const join = (...parts: Array<string | null | undefined>) => parts.filter((p) => p && p.trim()).join(' ');

type Loader = (id: string, partnerId: string) => Promise<LoadedEntity | null>;

const LOADERS: Record<WispEntityKind, Loader> = {
  ticket: async (id, partnerId) => {
    const [r] = await db
      .select({ orgId: tickets.orgId, number: tickets.ticketNumber, subject: tickets.subject, status: tickets.status, orgName: organizations.name })
      .from(tickets)
      .innerJoin(organizations, eq(organizations.id, tickets.orgId))
      .where(and(eq(tickets.id, id), isNull(tickets.deletedAt), orgPin(partnerId)))
      .limit(1);
    return r ? { orgId: r.orgId, orgName: r.orgName, title: join(`#${r.number}`, r.subject), status: r.status } : null;
  },
  quote: async (id, partnerId) => {
    const [r] = await db
      .select({ orgId: quotes.orgId, siteId: quotes.siteId, number: quotes.quoteNumber, title: quotes.title, status: quotes.status, orgName: organizations.name })
      .from(quotes)
      .innerJoin(organizations, eq(organizations.id, quotes.orgId))
      .where(and(eq(quotes.id, id), eq(quotes.partnerId, partnerId), orgPin(partnerId)))
      .limit(1);
    return r
      ? { orgId: r.orgId, siteId: r.siteId ?? null, orgName: r.orgName, title: join(r.number ?? 'Quote', r.title ?? r.orgName), status: r.status }
      : null;
  },
  invoice: async (id, partnerId) => {
    const [r] = await db
      .select({ orgId: invoices.orgId, siteId: invoices.siteId, number: invoices.invoiceNumber, status: invoices.status, orgName: organizations.name })
      .from(invoices)
      .innerJoin(organizations, eq(organizations.id, invoices.orgId))
      .where(and(eq(invoices.id, id), eq(invoices.partnerId, partnerId), orgPin(partnerId)))
      .limit(1);
    return r
      ? { orgId: r.orgId, siteId: r.siteId ?? null, orgName: r.orgName, title: join(r.number ?? 'Invoice', r.orgName), status: r.status }
      : null;
  },
  contract: async (id, partnerId) => {
    const [r] = await db
      .select({ orgId: contracts.orgId, name: contracts.name, status: contracts.status, orgName: organizations.name })
      .from(contracts)
      .innerJoin(organizations, eq(organizations.id, contracts.orgId))
      .where(and(eq(contracts.id, id), eq(contracts.partnerId, partnerId), orgPin(partnerId)))
      .limit(1);
    return r ? { orgId: r.orgId, orgName: r.orgName, title: r.name, status: r.status } : null;
  },
  device: async (id, partnerId) => {
    const [r] = await db
      .select({ orgId: devices.orgId, siteId: devices.siteId, hostname: devices.hostname, displayName: devices.displayName, status: devices.status, orgName: organizations.name })
      .from(devices)
      .innerJoin(organizations, eq(organizations.id, devices.orgId))
      .where(and(eq(devices.id, id), orgPin(partnerId)))
      .limit(1);
    return r ? { orgId: r.orgId, siteId: r.siteId, orgName: r.orgName, title: r.displayName || r.hostname, status: r.status } : null;
  },
  organization: async (id, partnerId) => {
    const [r] = await db
      .select({ id: organizations.id, name: organizations.name, status: organizations.status })
      .from(organizations)
      .where(and(eq(organizations.id, id), orgPin(partnerId)))
      .limit(1);
    return r ? { orgId: r.id, orgName: r.name, title: r.name, status: r.status } : null;
  },
  site: async (id, partnerId) => {
    const [r] = await db
      .select({ orgId: sites.orgId, id: sites.id, name: sites.name, orgName: organizations.name })
      .from(sites)
      .innerJoin(organizations, eq(organizations.id, sites.orgId))
      .where(and(eq(sites.id, id), orgPin(partnerId)))
      .limit(1);
    return r ? { orgId: r.orgId, siteId: r.id, orgName: r.orgName, title: join(r.name, `(${r.orgName})`), status: null } : null;
  },
  alert: async (id, partnerId) => {
    const [r] = await db
      .select({ orgId: alerts.orgId, title: alerts.title, severity: alerts.severity, status: alerts.status, orgName: organizations.name })
      .from(alerts)
      .innerJoin(organizations, eq(organizations.id, alerts.orgId))
      .where(and(eq(alerts.id, id), orgPin(partnerId)))
      .limit(1);
    return r ? { orgId: r.orgId, orgName: r.orgName, title: join(`[${r.severity}]`, r.title), status: r.status } : null;
  },
  run: async (id, partnerId) => {
    const [r] = await db
      .select({ orgId: aiAgentRuns.orgId, profile: aiAgentRuns.profile, status: aiAgentRuns.status, orgName: organizations.name })
      .from(aiAgentRuns)
      .innerJoin(organizations, eq(organizations.id, aiAgentRuns.orgId))
      .where(and(eq(aiAgentRuns.id, id), orgPin(partnerId)))
      .limit(1);
    return r ? { orgId: r.orgId, orgName: r.orgName, title: join(`Agent run (${r.profile})`, `— ${r.orgName}`), status: r.status } : null;
  },
  task: async (id, partnerId) => {
    const [r] = await db
      .select({ orgId: aiOperatorTasks.orgId, agentName: aiOperatorTasks.agentName, objective: aiOperatorTasks.objective, state: aiOperatorTasks.state, orgName: organizations.name })
      .from(aiOperatorTasks)
      .innerJoin(organizations, eq(organizations.id, aiOperatorTasks.orgId))
      .where(and(eq(aiOperatorTasks.id, id), orgPin(partnerId)))
      .limit(1);
    return r ? { orgId: r.orgId, orgName: r.orgName, title: join(`${r.agentName}:`, r.objective), status: r.state } : null;
  },
  user: async (id, partnerId) => {
    const [r] = await db
      .select({ name: users.name, status: users.status })
      .from(users)
      .where(and(eq(users.id, id), eq(users.partnerId, partnerId)))
      .limit(1);
    return r ? { orgId: null, orgName: null, title: r.name, status: r.status } : null;
  },
};

/** The entity inside `partnerId`, or null (missing, deleted, hidden org, or another partner's). */
export function loadEntityForPartner(kind: WispEntityKind, id: string, partnerId: string): Promise<LoadedEntity | null> {
  return inSystemContext(() => LOADERS[kind](id, partnerId));
}
