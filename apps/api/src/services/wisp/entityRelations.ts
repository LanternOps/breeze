/** One-hop IDs only. Callers must resolve each ref under their own auth and ceiling. */
import { and, asc, eq, isNull, notInArray } from 'drizzle-orm';
import type { WispEntityKind } from '@breeze/shared';
import { db } from '../../db';
import { alerts, contracts, devices, invoices, organizations, quotes, sites, tickets } from '../../db/schema';
import { notHiddenOrgType } from '../unassignedPool/visibility';
import { inSystemContext } from './grantAuthority';

type Ref = { kind: WispEntityKind; id: string };
const orgPin = (partnerId: string) => and(
  eq(organizations.partnerId, partnerId), isNull(organizations.deletedAt), notHiddenOrgType(),
);
const orgRef = (id: string): Ref => ({ kind: 'organization', id });
const pointer = (kind: WispEntityKind, id: string | null): Ref[] => id ? [{ kind, id }] : [];

export async function relatedRefs(partnerId: string, ref: Ref): Promise<Ref[]> {
  return inSystemContext(async () => {
    switch (ref.kind) {
      case 'ticket': {
        const [r] = await db.select({ deviceId: tickets.deviceId, orgId: tickets.orgId }).from(tickets)
          .innerJoin(organizations, eq(organizations.id, tickets.orgId))
          .where(and(eq(tickets.id, ref.id), isNull(tickets.deletedAt), orgPin(partnerId))).limit(1);
        return r ? [...pointer('device', r.deviceId), orgRef(r.orgId)] : [];
      }
      case 'device': {
        const [r] = await db.select({ siteId: devices.siteId, orgId: devices.orgId }).from(devices)
          .innerJoin(organizations, eq(organizations.id, devices.orgId))
          .where(and(eq(devices.id, ref.id), orgPin(partnerId))).limit(1);
        return r ? [...pointer('site', r.siteId), orgRef(r.orgId)] : [];
      }
      case 'alert': {
        const [r] = await db.select({ deviceId: alerts.deviceId, orgId: alerts.orgId }).from(alerts)
          .innerJoin(organizations, eq(organizations.id, alerts.orgId))
          .where(and(eq(alerts.id, ref.id), orgPin(partnerId))).limit(1);
        return r ? [...pointer('device', r.deviceId), orgRef(r.orgId)] : [];
      }
      case 'quote': {
        const [r] = await db.select({ siteId: quotes.siteId, orgId: quotes.orgId }).from(quotes)
          .innerJoin(organizations, eq(organizations.id, quotes.orgId))
          .where(and(eq(quotes.id, ref.id), eq(quotes.partnerId, partnerId), orgPin(partnerId))).limit(1);
        return r ? [orgRef(r.orgId), ...pointer('site', r.siteId)] : [];
      }
      case 'invoice': {
        const [r] = await db.select({ siteId: invoices.siteId, orgId: invoices.orgId }).from(invoices)
          .innerJoin(organizations, eq(organizations.id, invoices.orgId))
          .where(and(eq(invoices.id, ref.id), eq(invoices.partnerId, partnerId), orgPin(partnerId))).limit(1);
        return r ? [orgRef(r.orgId), ...pointer('site', r.siteId)] : [];
      }
      case 'contract': {
        const [r] = await db.select({ orgId: contracts.orgId }).from(contracts)
          .innerJoin(organizations, eq(organizations.id, contracts.orgId))
          .where(and(eq(contracts.id, ref.id), eq(contracts.partnerId, partnerId), orgPin(partnerId))).limit(1);
        return r ? [orgRef(r.orgId)] : [];
      }
      case 'site': {
        const [r] = await db.select({ orgId: sites.orgId }).from(sites)
          .innerJoin(organizations, eq(organizations.id, sites.orgId))
          .where(and(eq(sites.id, ref.id), orgPin(partnerId))).limit(1);
        return r ? [orgRef(r.orgId)] : [];
      }
      default: return [];
    }
  });
}

/** Upward pointers plus bounded device children; never a recursive traversal. */
export async function neighbourRefs(partnerId: string, ref: Ref): Promise<Ref[]> {
  return inSystemContext(async () => {
    const upward = await relatedRefs(partnerId, ref);
    if (ref.kind !== 'device') return upward;
    const orgId = upward.find((r) => r.kind === 'organization')?.id;
    if (!orgId) return [];
    const openTickets = await db.select({ id: tickets.id }).from(tickets)
      .innerJoin(organizations, eq(organizations.id, tickets.orgId))
      .where(and(eq(tickets.deviceId, ref.id), eq(tickets.orgId, orgId), orgPin(partnerId),
        isNull(tickets.deletedAt), notInArray(tickets.status, ['resolved', 'closed'])))
      .orderBy(asc(tickets.id)).limit(3);
    const activeAlerts = await db.select({ id: alerts.id }).from(alerts)
      .innerJoin(organizations, eq(organizations.id, alerts.orgId))
      .where(and(eq(alerts.deviceId, ref.id), eq(alerts.orgId, orgId), orgPin(partnerId), eq(alerts.status, 'active')))
      .orderBy(asc(alerts.id)).limit(3);
    return [...upward,
      ...openTickets.map(({ id }): Ref => ({ kind: 'ticket', id })),
      ...activeAlerts.map(({ id }): Ref => ({ kind: 'alert', id })),
    ];
  });
}
