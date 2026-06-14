// Owns ticketing configuration: custom statuses, priority SLA settings, and org-level overrides — per 2026-06-12 spec.

import { eq, and, asc, inArray } from 'drizzle-orm';
import { ticketStatuses, ticketPrioritySettings, orgTicketSettings } from '../db/schema';
import { ticketStatusEnum } from '../db/schema/portal';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { isPgUniqueViolation } from '../utils/pgErrors';
import type {
  CreateTicketStatusInput, UpdateTicketStatusInput, PrioritySettingsInput,
  OrgTicketSettingsInput, TicketPriorityValue
} from '@breeze/shared';
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
  // Negative values are invalid; upper-bound enforcement lives in the shared write validator (Task 6).
  if (v < 0) return null;
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

/**
 * Per-org billing defaults from org_ticket_settings.
 * System-context read — returns null when no row exists; never throws.
 * D6: org defaults win over category defaults in the time-entry chain.
 */
export async function getOrgBillingDefaults(orgId: string): Promise<{
  defaultHourlyRate: string | null;
  defaultBillable: boolean | null;
} | null> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          defaultHourlyRate: orgTicketSettings.defaultHourlyRate,
          defaultBillable: orgTicketSettings.defaultBillable,
        })
        .from(orgTicketSettings)
        .where(eq(orgTicketSettings.orgId, orgId))
        .limit(1)
    )
  );
  return rows[0] ?? null;
}

/**
 * Look up a ticket_statuses row by id.
 * System-context read — returns null when no row exists; never throws.
 */
export async function getTicketStatusById(id: string): Promise<{
  id: string; partnerId: string; coreStatus: CoreTicketStatus; name: string;
  isActive: boolean; isSystem: boolean;
} | null> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          id: ticketStatuses.id,
          partnerId: ticketStatuses.partnerId,
          coreStatus: ticketStatuses.coreStatus,
          name: ticketStatuses.name,
          isActive: ticketStatuses.isActive,
          isSystem: ticketStatuses.isSystem,
        })
        .from(ticketStatuses)
        .where(eq(ticketStatuses.id, id))
        .limit(1)
    )
  );
  return rows[0] ?? null;
}

/**
 * Find an active ticket_statuses row by name for the given partner (case-insensitive).
 * System-context read — returns null when no matching active row exists; never throws.
 */
export async function findStatusByName(
  partnerId: string,
  name: string,
): Promise<{ id: string; partnerId: string; coreStatus: CoreTicketStatus; name: string; isActive: boolean; isSystem: boolean } | null> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          id: ticketStatuses.id,
          partnerId: ticketStatuses.partnerId,
          coreStatus: ticketStatuses.coreStatus,
          name: ticketStatuses.name,
          isActive: ticketStatuses.isActive,
          isSystem: ticketStatuses.isSystem,
        })
        .from(ticketStatuses)
        .where(
          and(
            eq(ticketStatuses.partnerId, partnerId),
            eq(ticketStatuses.isActive, true),
          )
        )
    )
  );
  // Case-insensitive match in application code (normalise both sides to lower)
  const lowerName = name.toLowerCase();
  return rows.find((r) => r.name.toLowerCase() === lowerName) ?? null;
}

/**
 * List the display names of all active ticket_statuses rows for the given partner.
 * System-context read — used to build error messages for the AI tool.
 */
export async function listActiveStatusNames(partnerId: string): Promise<string[]> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ name: ticketStatuses.name })
        .from(ticketStatuses)
        .where(
          and(
            eq(ticketStatuses.partnerId, partnerId),
            eq(ticketStatuses.isActive, true),
          )
        )
    )
  );
  return rows.map((r) => r.name);
}

// ============================================================================
// CRUD layer (Task 6). All writes run in the REQUEST DB context (plain `db`):
// the caller's partner context is set and the partner-axis RLS policy is the
// real backstop. The system-context config reads above are unchanged.
// ============================================================================

export type TicketConfigServiceErrorCode =
  | 'STATUS_NAME_TAKEN'
  | 'STATUS_NOT_FOUND'
  | 'SYSTEM_STATUS_IMMUTABLE'
  | 'SYSTEM_STATUS_REQUIRED';

export class TicketConfigServiceError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 400, public code?: TicketConfigServiceErrorCode) {
    super(message);
    this.name = 'TicketConfigServiceError';
  }
}

const PRIORITIES: TicketPriorityValue[] = ['low', 'normal', 'high', 'urgent'];

function isUniqueNameViolation(err: unknown): boolean {
  // Only the name-uniqueness index counts as a name collision; other 23505s
  // (e.g. ticket_statuses_partner_core_status_system_uq) must propagate as-is.
  // isPgUniqueViolation unwraps the DrizzleQueryError `.cause` — a bare
  // `err.code` check missed every wrapped insert and leaked a 500 (BUG: dup
  // status name returned 500 instead of STATUS_NAME_TAKEN).
  return isPgUniqueViolation(err, 'ticket_statuses_partner_name_uq');
}

type PriorityConfig = {
  label: string | null;
  responseSlaMinutes: number | null;
  resolutionSlaMinutes: number | null;
};

async function readPriorities(partnerId: string): Promise<Record<TicketPriorityValue, PriorityConfig>> {
  const rows = await db
    .select({
      priority: ticketPrioritySettings.priority,
      label: ticketPrioritySettings.label,
      responseSlaMinutes: ticketPrioritySettings.responseSlaMinutes,
      resolutionSlaMinutes: ticketPrioritySettings.resolutionSlaMinutes,
    })
    .from(ticketPrioritySettings)
    .where(eq(ticketPrioritySettings.partnerId, partnerId));

  const byPriority = new Map(rows.map((r) => [r.priority as TicketPriorityValue, r]));
  const out = {} as Record<TicketPriorityValue, PriorityConfig>;
  for (const p of PRIORITIES) {
    const row = byPriority.get(p);
    out[p] = {
      label: row?.label ?? null,
      responseSlaMinutes: row?.responseSlaMinutes ?? null,
      resolutionSlaMinutes: row?.resolutionSlaMinutes ?? null,
    };
  }
  return out;
}

/**
 * Full partner ticketing configuration: every custom + system status (ordered)
 * and the merged per-priority SLA settings (nulls where unset).
 */
export async function getTicketConfig(partnerId: string) {
  const statuses = await db
    .select({
      id: ticketStatuses.id,
      name: ticketStatuses.name,
      coreStatus: ticketStatuses.coreStatus,
      color: ticketStatuses.color,
      sortOrder: ticketStatuses.sortOrder,
      isSystem: ticketStatuses.isSystem,
      isActive: ticketStatuses.isActive,
    })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.partnerId, partnerId))
    .orderBy(asc(ticketStatuses.sortOrder), asc(ticketStatuses.name));

  const priorities = await readPriorities(partnerId);
  return { statuses, priorities };
}

export async function createTicketStatus(partnerId: string, input: CreateTicketStatusInput) {
  try {
    const [row] = await db
      .insert(ticketStatuses)
      .values({
        partnerId,
        name: input.name,
        coreStatus: input.coreStatus,
        color: input.color ?? null,
        sortOrder: input.sortOrder ?? 0,
        isSystem: false,
        isActive: true,
      })
      .returning();
    return row;
  } catch (err) {
    if (isUniqueNameViolation(err)) {
      throw new TicketConfigServiceError('A status with this name already exists', 409, 'STATUS_NAME_TAKEN');
    }
    throw err;
  }
}

export async function updateTicketStatus(partnerId: string, id: string, input: UpdateTicketStatusInput) {
  const existing = await db
    .select({
      id: ticketStatuses.id,
      coreStatus: ticketStatuses.coreStatus,
      isSystem: ticketStatuses.isSystem,
    })
    .from(ticketStatuses)
    .where(and(eq(ticketStatuses.id, id), eq(ticketStatuses.partnerId, partnerId)))
    .limit(1);

  const row = existing[0];
  if (!row) {
    throw new TicketConfigServiceError('Status not found', 404, 'STATUS_NOT_FOUND');
  }

  if (row.isSystem) {
    if (input.coreStatus !== undefined && input.coreStatus !== row.coreStatus) {
      throw new TicketConfigServiceError('System statuses cannot be remapped to a different core state', 400, 'SYSTEM_STATUS_IMMUTABLE');
    }
    if (input.isActive === false) {
      throw new TicketConfigServiceError('System statuses cannot be deactivated', 400, 'SYSTEM_STATUS_REQUIRED');
    }
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.coreStatus !== undefined) patch.coreStatus = input.coreStatus;
  if (input.color !== undefined) patch.color = input.color;
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
  if (input.isActive !== undefined) patch.isActive = input.isActive;

  try {
    const [updated] = await db
      .update(ticketStatuses)
      .set(patch)
      .where(and(eq(ticketStatuses.id, id), eq(ticketStatuses.partnerId, partnerId)))
      .returning();
    if (!updated) throw new TicketConfigServiceError('Status not found', 404, 'STATUS_NOT_FOUND');
    return updated;
  } catch (err) {
    if (err instanceof TicketConfigServiceError) throw err;
    if (isUniqueNameViolation(err)) {
      throw new TicketConfigServiceError('A status with this name already exists', 409, 'STATUS_NAME_TAKEN');
    }
    throw err;
  }
}

/**
 * Assign sortOrder by array position. Ids that don't belong to the partner are
 * skipped silently; the WHERE clause keys on (id, partnerId). withDbAccessContext
 * wraps the request in a transaction, so the sequential updates commit atomically.
 */
export async function reorderTicketStatuses(partnerId: string, ids: string[]): Promise<{ updated: number }> {
  const owned = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(and(inArray(ticketStatuses.id, ids), eq(ticketStatuses.partnerId, partnerId)));
  const ownedIds = new Set(owned.map((r) => r.id));

  let updated = 0;
  for (const [index, id] of ids.entries()) {
    if (!ownedIds.has(id)) continue;
    await db
      .update(ticketStatuses)
      .set({ sortOrder: index, updatedAt: new Date() })
      .where(and(eq(ticketStatuses.id, id), eq(ticketStatuses.partnerId, partnerId)));
    updated += 1;
  }
  return { updated };
}

/**
 * Upsert per-priority SLA settings. Each provided priority is upserted on the
 * (partner_id, priority) unique index; only fields present in the payload are
 * written on conflict. Returns the merged priorities map.
 */
export async function upsertPrioritySettings(partnerId: string, input: PrioritySettingsInput) {
  for (const [priority, settings] of Object.entries(input.priorities)) {
    if (!settings) continue;
    const setPatch: Record<string, unknown> = { updatedAt: new Date() };
    if (settings.label !== undefined) setPatch.label = settings.label ?? null;
    if (settings.responseSlaMinutes !== undefined) setPatch.responseSlaMinutes = settings.responseSlaMinutes ?? null;
    if (settings.resolutionSlaMinutes !== undefined) setPatch.resolutionSlaMinutes = settings.resolutionSlaMinutes ?? null;

    await db
      .insert(ticketPrioritySettings)
      .values({
        partnerId,
        priority: priority as TicketPriorityValue,
        label: settings.label ?? null,
        responseSlaMinutes: settings.responseSlaMinutes ?? null,
        resolutionSlaMinutes: settings.resolutionSlaMinutes ?? null,
      })
      .onConflictDoUpdate({
        target: [ticketPrioritySettings.partnerId, ticketPrioritySettings.priority],
        set: setPatch,
      });
  }
  return readPriorities(partnerId);
}

function toOrgTicketSettingsResponse(orgId: string, row?: {
  slaOverrides?: unknown;
  defaultHourlyRate?: string | null;
  defaultBillable?: boolean | null;
}) {
  return {
    orgId,
    slaOverrides: (row?.slaOverrides ?? {}) as Record<string, unknown>,
    defaultHourlyRate: row?.defaultHourlyRate ?? null,
    defaultBillable: row?.defaultBillable ?? null,
  };
}

export async function getOrgTicketSettings(orgId: string) {
  const rows = await db
    .select({
      slaOverrides: orgTicketSettings.slaOverrides,
      defaultHourlyRate: orgTicketSettings.defaultHourlyRate,
      defaultBillable: orgTicketSettings.defaultBillable,
    })
    .from(orgTicketSettings)
    .where(eq(orgTicketSettings.orgId, orgId))
    .limit(1);
  return toOrgTicketSettingsResponse(orgId, rows[0]);
}

/**
 * Upsert org-level ticket settings on the org_id unique index. slaOverrides is
 * REPLACED WHOLESALE when provided (not merged) — the client sends the full
 * desired override map. defaultHourlyRate is a numeric column, so Drizzle wants
 * a string; we convert with String() (null stays null).
 */
export async function upsertOrgTicketSettings(orgId: string, input: OrgTicketSettingsInput) {
  const fields: Record<string, unknown> = {};
  if (input.slaOverrides !== undefined) fields.slaOverrides = input.slaOverrides;
  if (input.defaultHourlyRate !== undefined) {
    fields.defaultHourlyRate = input.defaultHourlyRate == null ? null : String(input.defaultHourlyRate);
  }
  if (input.defaultBillable !== undefined) fields.defaultBillable = input.defaultBillable;

  const [row] = await db
    .insert(orgTicketSettings)
    .values({ orgId, ...fields })
    .onConflictDoUpdate({
      target: orgTicketSettings.orgId,
      set: { ...fields, updatedAt: new Date() },
    })
    .returning();
  return toOrgTicketSettingsResponse(orgId, row);
}
