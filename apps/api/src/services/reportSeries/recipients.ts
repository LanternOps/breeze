/**
 * Multi-org report series — recipients (spec §3.5).
 *
 *   customer = (rule matches in the child's org ∪ child 'add' rows) − child 'remove' rows
 *   cc       = series.internal_cc (materialized as the child's config.emailRecipients)
 *
 * recipient_count is |customer| (INDEX ruling); internal CC is excluded.
 */
import { and, eq, inArray, isNotNull, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { contacts, reportScheduleRecipients } from '../../db/schema';
import { resolveOrganizationResponsibilitiesForOrgs } from '../contacts/responsibilities';
import { CONTACT_ROLES, type ContactRole } from '../contacts/types';
import type { SeriesRecipientRule, SeriesTx } from './types';

/** The same loose regex as ReportBuilder's chips and the schedule worker. */
export function isValidRecipientEmail(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export interface RecipientContact {
  contactId: string;
  email: string | null;
}
export interface RecipientOverride extends RecipientContact {
  mode: 'add' | 'remove';
}
export interface SeriesRecipients {
  customer: string[];
  cc: string[];
  /** Candidates dropped for a missing or invalid address (W01 'partial'). */
  dropped: number;
}

function dedupeEmails(values: ReadonlyArray<string | null | undefined>): { emails: string[]; dropped: number } {
  const byKey = new Map<string, string>();
  let dropped = 0;
  for (const value of values) {
    if (!isValidRecipientEmail(value)) {
      dropped += 1;
      continue;
    }
    const email = value.trim();
    const key = email.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, email);
  }
  return { emails: [...byKey.values()], dropped };
}

export function mergeSeriesRecipients(input: {
  ruleMatches: RecipientContact[];
  overrides: RecipientOverride[];
  internalCc: readonly string[];
}): SeriesRecipients {
  const removed = new Set(
    input.overrides.filter((row) => row.mode === 'remove').map((row) => row.contactId),
  );
  const candidates = [
    ...input.ruleMatches,
    ...input.overrides.filter((row) => row.mode === 'add'),
  ].filter((row) => !removed.has(row.contactId));
  const customer = dedupeEmails(candidates.map((row) => row.email));
  const cc = dedupeEmails(input.internalCc);
  return { customer: customer.emails, cc: cc.emails, dropped: customer.dropped + cc.dropped };
}

function ruleCondition(rule: SeriesRecipientRule, roleContactIds: readonly string[]): SQL | undefined {
  const arms: SQL[] = [];
  if (rule.primaryContact) arms.push(and(eq(contacts.isPrimary, true), isNull(contacts.siteId))!);
  if (roleContactIds.length > 0) arms.push(inArray(contacts.id, [...roleContactIds]));
  if (arms.length === 0) return undefined;
  return arms.length === 1 ? arms[0] : or(...arms);
}

async function loadRuleMatches(
  orgIds: readonly string[],
  rule: SeriesRecipientRule,
  tx: SeriesTx,
): Promise<Array<RecipientContact & { orgId: string }>> {
  if (orgIds.length === 0) return [];

  const roles = rule.roles.filter(
    (role): role is ContactRole => (CONTACT_ROLES as readonly string[]).includes(role),
  );
  const resolved = await resolveOrganizationResponsibilitiesForOrgs(tx, { orgIds, roles });
  const roleContactIds = [...new Set(resolved.map((assignment) => assignment.contactId))];
  const condition = ruleCondition(rule, roleContactIds);
  if (!condition) return [];

  return tx
    .select({ orgId: contacts.orgId, contactId: contacts.id, email: contacts.email })
    .from(contacts)
    .where(and(inArray(contacts.orgId, [...orgIds]), isNotNull(contacts.email), condition));
}

async function loadOverrides(
  reportIds: readonly string[],
  tx: SeriesTx,
): Promise<Array<RecipientOverride & { reportId: string }>> {
  if (reportIds.length === 0) return [];
  return tx
    .select({
      reportId: reportScheduleRecipients.reportId,
      contactId: reportScheduleRecipients.contactId,
      mode: reportScheduleRecipients.mode,
      email: contacts.email,
    })
    .from(reportScheduleRecipients)
    .innerJoin(
      contacts,
      and(
        eq(contacts.id, reportScheduleRecipients.contactId),
        eq(contacts.orgId, reportScheduleRecipients.orgId),
      ),
    )
    .where(inArray(reportScheduleRecipients.reportId, [...reportIds]));
}

/** Two queries for any number of orgs (preview, detail, worker). */
export async function resolveSeriesRecipientsForOrgs(args: {
  orgIds: readonly string[];
  rule: SeriesRecipientRule;
  internalCc: readonly string[];
  childReportIdByOrg: ReadonlyMap<string, string>;
  tx?: SeriesTx;
}): Promise<Map<string, SeriesRecipients>> {
  const tx = args.tx ?? db;
  const matches = await loadRuleMatches(args.orgIds, args.rule, tx);
  const reportIds = args.orgIds
    .map((orgId) => args.childReportIdByOrg.get(orgId))
    .filter((id): id is string => typeof id === 'string');
  const overrides = await loadOverrides(reportIds, tx);

  const result = new Map<string, SeriesRecipients>();
  for (const orgId of args.orgIds) {
    const reportId = args.childReportIdByOrg.get(orgId);
    result.set(orgId, mergeSeriesRecipients({
      ruleMatches: matches.filter((row) => row.orgId === orgId),
      overrides: reportId ? overrides.filter((row) => row.reportId === reportId) : [],
      internalCc: args.internalCc,
    }));
  }
  return result;
}

export async function resolveSeriesChildRecipients(args: {
  reportId: string;
  orgId: string;
  rule: SeriesRecipientRule;
  internalCc: string[];
}): Promise<SeriesRecipients> {
  const byOrg = await resolveSeriesRecipientsForOrgs({
    orgIds: [args.orgId],
    rule: args.rule,
    internalCc: args.internalCc,
    childReportIdByOrg: new Map([[args.orgId, args.reportId]]),
  });
  return byOrg.get(args.orgId) ?? { customer: [], cc: [], dropped: 0 };
}

/**
 * Detach (spec §3.6, plan Contract concern 7): the standalone report keeps
 * mailing exactly the customers the series was mailing. Current rule matches
 * that are not removed become 'add' rows; 'remove' rows are dropped (they
 * mean nothing without a rule, and the ordinary resolver must never see one).
 */
export async function materializeDetachedRecipients(
  tx: SeriesTx,
  args: { reportId: string; orgId: string; rule: SeriesRecipientRule },
): Promise<{ added: number; removedDropped: number }> {
  const matches = await loadRuleMatches([args.orgId], args.rule, tx);
  const overrides = await loadOverrides([args.reportId], tx);
  const removed = new Set(overrides.filter((row) => row.mode === 'remove').map((row) => row.contactId));
  const toAdd = [...new Set(matches.map((row) => row.contactId))].filter((id) => !removed.has(id));

  let added = 0;
  if (toAdd.length > 0) {
    const inserted = await tx
      .insert(reportScheduleRecipients)
      .values(toAdd.map((contactId) => ({ reportId: args.reportId, orgId: args.orgId, contactId, mode: 'add' as const })))
      .onConflictDoNothing()
      .returning({ id: reportScheduleRecipients.id });
    added = inserted.length;
  }
  const dropped = await tx
    .delete(reportScheduleRecipients)
    .where(and(
      eq(reportScheduleRecipients.reportId, args.reportId),
      eq(reportScheduleRecipients.orgId, args.orgId),
      eq(reportScheduleRecipients.mode, 'remove'),
    ))
    .returning({ id: reportScheduleRecipients.id });
  return { added, removedDropped: dropped.length };
}
