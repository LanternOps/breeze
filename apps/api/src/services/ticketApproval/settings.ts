import { and, eq, isNotNull, or } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import {
  orgTicketApprovalSettingsPatchSchema,
  partnerTicketApprovalSettingsPatchSchema,
  type OrgTicketApprovalSettingsPatch,
  type PartnerTicketApprovalSettingsPatch,
} from '@breeze/shared';
import { organizations, ticketApprovalSettings, type TicketApprovalEnforcement } from '../../db/schema';
import type { Effective, SettingSource } from '../autopay/billingPaymentSettings';
import type { Tx } from '../autopay/types';

/**
 * Customer work approval policy (#4617 spec §4.1, §7): partner default → org
 * override → snapshotted on the request at creation. This module is the ONLY
 * reader and writer of ticket_approval_settings — the gate, the settings UI,
 * the ticket UI and the expiry sweep all go through
 * {@link resolveTicketApprovalSettings}.
 */

export interface EffectiveTicketApprovalSettings {
  enabled: Effective<boolean>;
  budgetTrigger: Effective<boolean>;
  afterHoursTrigger: Effective<boolean>;
  enforcement: Effective<TicketApprovalEnforcement>;
  requestTtlHours: Effective<number>;
}

/** Off by default: nothing changes for a partner until they enable it (spec §8). */
export const TICKET_APPROVAL_SETTINGS_DEFAULTS: {
  enabled: boolean;
  budgetTrigger: boolean;
  afterHoursTrigger: boolean;
  enforcement: TicketApprovalEnforcement;
  requestTtlHours: number;
} = {
  enabled: false,
  budgetTrigger: true,
  afterHoursTrigger: true,
  enforcement: 'soft',
  requestTtlHours: 72,
};

type SettingsFields = Pick<typeof ticketApprovalSettings.$inferSelect,
  'enabled' | 'budgetTrigger' | 'afterHoursTrigger' | 'enforcement' | 'requestTtlHours'>;

function pick<T>(org: T | null | undefined, partner: T | null | undefined, fallback: T): Effective<T> {
  // `!= null`, not truthiness: an org `false` is a value that beats a partner `true`.
  if (org != null) return { value: org, source: 'org' satisfies SettingSource };
  if (partner != null) return { value: partner, source: 'partner' };
  return { value: fallback, source: 'default' };
}

/** Pure field-by-field inheritance; exported for unit tests. */
export function pickEffectiveTicketApprovalSettings(
  org: SettingsFields | undefined,
  partner: SettingsFields | undefined,
): EffectiveTicketApprovalSettings {
  const d = TICKET_APPROVAL_SETTINGS_DEFAULTS;
  return {
    enabled: pick(org?.enabled, partner?.enabled, d.enabled),
    budgetTrigger: pick(org?.budgetTrigger, partner?.budgetTrigger, d.budgetTrigger),
    afterHoursTrigger: pick(org?.afterHoursTrigger, partner?.afterHoursTrigger, d.afterHoursTrigger),
    enforcement: pick(org?.enforcement, partner?.enforcement, d.enforcement),
    requestTtlHours: pick(org?.requestTtlHours, partner?.requestTtlHours, d.requestTtlHours),
  };
}

/**
 * Resolve the effective policy for a partner, or for one of its orgs. Throws
 * 404 when `orgId` is not an org of `partnerId`, so a caller can never read
 * one partner's default through another partner's org.
 */
export async function resolveTicketApprovalSettings(
  db: Tx,
  args: { partnerId: string; orgId?: string | null },
): Promise<EffectiveTicketApprovalSettings> {
  if (args.orgId) {
    const [org] = await db.select({ id: organizations.id }).from(organizations)
      .where(and(eq(organizations.id, args.orgId), eq(organizations.partnerId, args.partnerId))).limit(1);
    if (!org) throw new HTTPException(404, { message: 'Organization not found' });
  }
  const rows = await db.select().from(ticketApprovalSettings).where(or(
    eq(ticketApprovalSettings.partnerId, args.partnerId),
    args.orgId ? eq(ticketApprovalSettings.orgId, args.orgId) : undefined,
  ));
  const partner = rows.find((r) => r.partnerId === args.partnerId && r.orgId === null);
  const org = args.orgId ? rows.find((r) => r.orgId === args.orgId && r.partnerId === null) : undefined;
  return pickEffectiveTicketApprovalSettings(org, partner);
}

function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Upsert the partner-default row. Caller authorizes (canManagePartnerWidePolicies). */
export async function updatePartnerTicketApprovalSettings(
  db: Tx, partnerId: string, patch: PartnerTicketApprovalSettingsPatch,
): Promise<void> {
  const fields = definedOnly(partnerTicketApprovalSettingsPatchSchema.parse(patch));
  if (!Object.keys(fields).length) return;
  const set = { ...fields, updatedAt: new Date() };
  await db.insert(ticketApprovalSettings).values({ partnerId, orgId: null, ...fields })
    .onConflictDoUpdate({
      target: ticketApprovalSettings.partnerId,
      targetWhere: isNotNull(ticketApprovalSettings.partnerId),
      set,
    });
}

/** Upsert the org-override row; a `null` field clears that override (inherit). */
export async function updateOrgTicketApprovalSettings(
  db: Tx, orgId: string, patch: OrgTicketApprovalSettingsPatch,
): Promise<void> {
  const fields = definedOnly(orgTicketApprovalSettingsPatchSchema.parse(patch));
  if (!Object.keys(fields).length) return;
  const set = { ...fields, updatedAt: new Date() };
  await db.insert(ticketApprovalSettings).values({ orgId, partnerId: null, ...fields })
    .onConflictDoUpdate({
      target: ticketApprovalSettings.orgId,
      targetWhere: isNotNull(ticketApprovalSettings.orgId),
      set,
    });
}
