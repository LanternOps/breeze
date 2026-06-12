// Owns ticketing configuration: custom statuses, priority SLA settings, and org-level overrides — per 2026-06-12 spec.

import { eq, and } from 'drizzle-orm';
import { ticketStatuses, ticketPrioritySettings, orgTicketSettings } from '../db/schema';
import { ticketStatusEnum } from '../db/schema/portal';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import type { TicketSlaPriority } from './ticketSla';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CoreTicketStatus = (typeof ticketStatusEnum.enumValues)[number];

export const DEFAULT_STATUSES: Array<{
  coreStatus: CoreTicketStatus;
  name: string;
  sortOrder: number;
}> = [
  { coreStatus: 'new', name: 'New', sortOrder: 0 },
  { coreStatus: 'open', name: 'Open', sortOrder: 1 },
  { coreStatus: 'pending', name: 'Pending', sortOrder: 2 },
  { coreStatus: 'on_hold', name: 'On hold', sortOrder: 3 },
  { coreStatus: 'resolved', name: 'Resolved', sortOrder: 4 },
  { coreStatus: 'closed', name: 'Closed', sortOrder: 5 },
];

/**
 * Insert the six system ticket statuses for a newly created partner.
 * Called inside `createPartner`'s transaction — `tx` is the Drizzle
 * transaction object.
 */
export async function seedSystemTicketStatuses(
  tx: Tx,
  partnerId: string,
): Promise<void> {
  await tx
    .insert(ticketStatuses)
    .values(
      DEFAULT_STATUSES.map((s) => ({
        partnerId,
        name: s.name,
        coreStatus: s.coreStatus,
        sortOrder: s.sortOrder,
        isSystem: true,
      })),
    );
}

/**
 * Parse a single SLA minutes value defensively. Returns null for anything that
 * isn't a finite integer (rejects floats, strings, nulls, missing keys).
 */
function parseSlaMinutes(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number') return null;
  if (!Number.isFinite(v)) return null;
  if (!Number.isInteger(v)) return null;
  return v;
}

/**
 * Per-priority SLA minutes from org_ticket_settings.sla_overrides, or nulls.
 * System-context read — never throws on malformed config.
 */
export async function getOrgSlaOverride(
  orgId: string,
  priority: TicketSlaPriority,
): Promise<{ responseMinutes: number | null; resolutionMinutes: number | null }> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ slaOverrides: orgTicketSettings.slaOverrides })
        .from(orgTicketSettings)
        .where(eq(orgTicketSettings.orgId, orgId))
        .limit(1)
    )
  );
  const row = rows[0];
  if (!row) return { responseMinutes: null, resolutionMinutes: null };

  const overrides = row.slaOverrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { responseMinutes: null, resolutionMinutes: null };
  }
  const tier = (overrides as Record<string, unknown>)[priority];
  if (!tier || typeof tier !== 'object' || Array.isArray(tier)) {
    return { responseMinutes: null, resolutionMinutes: null };
  }
  const t = tier as Record<string, unknown>;
  return {
    responseMinutes: parseSlaMinutes(t['responseMinutes']),
    resolutionMinutes: parseSlaMinutes(t['resolutionMinutes']),
  };
}

/**
 * Per-priority SLA minutes from ticket_priority_settings, or nulls.
 * System-context read — missing row returns nulls, never throws.
 */
export async function getPartnerPrioritySla(
  partnerId: string,
  priority: TicketSlaPriority,
): Promise<{ responseMinutes: number | null; resolutionMinutes: number | null }> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          responseSlaMinutes: ticketPrioritySettings.responseSlaMinutes,
          resolutionSlaMinutes: ticketPrioritySettings.resolutionSlaMinutes,
        })
        .from(ticketPrioritySettings)
        .where(
          and(
            eq(ticketPrioritySettings.partnerId, partnerId),
            eq(ticketPrioritySettings.priority, priority as 'low' | 'normal' | 'high' | 'urgent'),
          )
        )
        .limit(1)
    )
  );
  const row = rows[0];
  if (!row) return { responseMinutes: null, resolutionMinutes: null };
  return {
    responseMinutes: parseSlaMinutes(row.responseSlaMinutes),
    resolutionMinutes: parseSlaMinutes(row.resolutionSlaMinutes),
  };
}

/**
 * Resolve the system ticket_statuses row id for a given partner + core status.
 * System-context read — returns null when no row exists; never throws.
 */
export async function getSystemStatusId(
  partnerId: string,
  coreStatus: CoreTicketStatus,
): Promise<string | null> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(
          and(
            eq(ticketStatuses.partnerId, partnerId),
            eq(ticketStatuses.coreStatus, coreStatus),
            eq(ticketStatuses.isSystem, true),
          )
        )
        .limit(1)
    )
  );
  return rows[0]?.id ?? null;
}
