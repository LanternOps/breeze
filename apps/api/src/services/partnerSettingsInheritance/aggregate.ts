/**
 * Tab aggregate for the partner settings inheritance read model (#9170, spec
 * §5.6).
 *
 * Query budget per tab: ONE read of the partner's own row (settings plus the
 * visible org count), then ONE set-based aggregate per org-source kind the tab
 * uses. Each count is `COUNT(*) FILTER (WHERE <bucketSql>)` over the
 * caller-visible orgs; there is no per-org loop, no per-org query and no
 * `getEffectiveOrgSettings` call. Aliases are positional (`c0…cN`) and mapped
 * back to (field, bucket) here, so no id reaches SQL text, and no query selects
 * `organizations.settings` whole.
 *
 * Every read runs in the caller's request DB context (set by authMiddleware),
 * so RLS limits rows to orgs the caller can access; the population predicate
 * then narrows to exactly the org list's set. Never a system context here.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  catalogForTab,
  type CatalogEntry,
  type CatalogTabKey,
  type InheritanceCounts,
  type InheritanceFieldDto,
  type InheritanceTabDto,
} from '@breeze/shared';
import { db } from '../../db';
import { organizations, partners } from '../../db/schema/orgs';
import { aiBudgets } from '../../db/schema/ai';
import { portalBranding } from '../../db/schema/portal';
import { notificationChannelConfigs, notificationChannels } from '../../db/schema/alerts';
import { partnerVisibleOrgConditions } from '../partnerVisibleOrgs';
import { BINDINGS, BUCKETS, type Bucket, type OrgSourceKind } from './bindings';

export interface InheritanceContext {
  partnerId: string;
  /** From the auth context. `null` is never "all orgs" here: it throws. */
  accessibleOrgIds: readonly string[] | null;
}

/** Unknown field, or the caller's partner row is not readable. */
export class InheritanceNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InheritanceNotFound';
  }
}

/** A request the catalog cannot answer (no org source, bucket not applicable, bad cursor). */
export class InheritanceBadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InheritanceBadRequest';
  }
}

export function requireAccessibleOrgIds(ctx: InheritanceContext): readonly string[] {
  if (ctx.accessibleOrgIds === null) {
    // Partner scope always carries a list; null would mean "unscoped".
    throw new Error('partner settings inheritance: accessibleOrgIds is required');
  }
  return ctx.accessibleOrgIds;
}

export function visibleOrgsSql(accessibleOrgIds: readonly string[]): SQL {
  return and(...partnerVisibleOrgConditions(accessibleOrgIds))!;
}

/** The caller's own partner row (partner-axis RLS) plus the visible org count, in one query. */
export async function readPartnerSettings(
  ctx: InheritanceContext,
  accessibleOrgIds: readonly string[],
): Promise<{ settings: unknown; orgCount: number }> {
  const [row] = await db
    .select({
      settings: partners.settings,
      orgCount: sql<number>`(SELECT count(*)::int FROM ${organizations} WHERE ${visibleOrgsSql(accessibleOrgIds)})`,
    })
    .from(partners)
    .where(eq(partners.id, ctx.partnerId))
    .limit(1);
  if (!row) throw new InheritanceNotFound('Partner not found');
  if (row.orgCount === null || row.orgCount === undefined) throw new Error('partner settings org count is missing');
  return { settings: row.settings ?? {}, orgCount: Number(row.orgCount) };
}

/** `FROM` clause per org-source kind: one row per visible org. */
export function orgSourceFrom(kind: Exclude<OrgSourceKind, 'pushoverChannels'>): SQL {
  switch (kind) {
    case 'orgSettings':
      return sql`${organizations}`;
    case 'aiBudgets':
      return sql`${organizations} LEFT JOIN ${aiBudgets} ON ${aiBudgets.orgId} = ${organizations.id}`;
    case 'portalBranding':
      return sql`${organizations} LEFT JOIN ${portalBranding} ON ${portalBranding.orgId} = ${organizations.id}`;
  }
}

/** Org-owned Pushover channels with their config rows. Partner-wide channels (org_id NULL) never count. */
export const PUSHOVER_CHANNELS_FROM = sql`${notificationChannels} JOIN ${notificationChannelConfigs} ON ${notificationChannelConfigs.channelId} = ${notificationChannels.id}`;
export const PUSHOVER_CHANNELS_WHERE = sql`${notificationChannels.type} = 'pushover' AND ${notificationChannels.orgId} IS NOT NULL`;

interface Slot {
  alias: string;
  fieldId: string;
  bucket: Bucket;
  predicate: SQL;
}

function aliasSql(alias: string): SQL {
  // Generated from an integer index only (`c0…cN`).
  return sql.raw(`"${alias}"`);
}

function aggregateQuery(kind: OrgSourceKind, slots: Slot[], visible: SQL): SQL {
  if (kind === 'pushoverChannels') {
    // Pre-aggregate per org, so an org with several channels counts once.
    const perChannel = sql.join(
      slots.map((s) => sql`coalesce(bool_or(${s.predicate}), false) AS ${aliasSql(s.alias)}`),
      sql`, `,
    );
    const counts = sql.join(
      slots.map((s) => sql`count(*) FILTER (WHERE per_org.${aliasSql(s.alias)})::int AS ${aliasSql(s.alias)}`),
      sql`, `,
    );
    return sql`WITH per_org AS (
      SELECT ${notificationChannels.orgId} AS org_id, ${perChannel}
      FROM ${PUSHOVER_CHANNELS_FROM}
      WHERE ${PUSHOVER_CHANNELS_WHERE}
      GROUP BY ${notificationChannels.orgId}
    )
    SELECT ${counts}
    FROM ${organizations} JOIN per_org ON per_org.org_id = ${organizations.id}
    WHERE ${visible}`;
  }
  const counts = sql.join(
    slots.map((s) => sql`count(*) FILTER (WHERE ${s.predicate})::int AS ${aliasSql(s.alias)}`),
    sql`, `,
  );
  return sql`SELECT ${counts} FROM ${orgSourceFrom(kind)} WHERE ${visible}`;
}

function zeroCounts(entry: CatalogEntry): InheritanceCounts {
  const counts: InheritanceCounts = { ownValue: 0, overrides: entry.secret ? null : 0, shadowed: 0 };
  if (entry.qualifier === 'cap') counts.clamped = 0;
  return counts;
}

export async function aggregateTab(tab: CatalogTabKey, ctx: InheritanceContext): Promise<InheritanceTabDto> {
  const accessibleOrgIds = requireAccessibleOrgIds(ctx);
  const entries = catalogForTab(tab);
  const { settings: partnerSettings, orgCount } = await readPartnerSettings(ctx, accessibleOrgIds);
  const visible = visibleOrgsSql(accessibleOrgIds);

  // Group every computable (field, bucket) predicate by org-source kind.
  const byKind = new Map<OrgSourceKind, Slot[]>();
  let next = 0;
  for (const entry of entries) {
    const binding = BINDINGS[entry.id]!;
    if (!binding.orgSource) continue;
    for (const bucket of BUCKETS) {
      const predicate = binding.bucketSql(bucket, partnerSettings);
      if (!predicate) continue;
      const slots = byKind.get(binding.orgSource.kind) ?? [];
      slots.push({ alias: `c${next++}`, fieldId: entry.id, bucket, predicate });
      byKind.set(binding.orgSource.kind, slots);
    }
  }

  // Only fields with an org source have counts; the rest report `null`, never zeros.
  const counts = new Map(
    entries.filter((entry) => BINDINGS[entry.id]!.orgSource).map((entry) => [entry.id, zeroCounts(entry)]),
  );
  for (const [kind, slots] of byKind) {
    const rows = (await db.execute(aggregateQuery(kind, slots, visible))) as unknown as Record<string, unknown>[];
    // An aggregate without GROUP BY always returns exactly one row with every
    // alias; anything else is a fault, never "zero orgs".
    if (rows.length !== 1) throw new Error(`partner settings aggregate returned ${rows.length} rows for ${kind}`);
    const row = rows[0]!;
    for (const slot of slots) {
      const raw = row[slot.alias];
      if (raw === undefined || raw === null) throw new Error(`partner settings aggregate is missing ${slot.alias}`);
      const value = Number(raw);
      const fieldCounts = counts.get(slot.fieldId)!;
      if (slot.bucket === 'overrides') fieldCounts.overrides = value;
      else if (slot.bucket === 'clamped') fieldCounts.clamped = value;
      else fieldCounts[slot.bucket] = value;
    }
  }

  const fields: InheritanceFieldDto[] = entries.map((entry) => {
    const binding = BINDINGS[entry.id]!;
    const dto: InheritanceFieldDto = {
      id: entry.id,
      kind: entry.kind,
      partnerSet: binding.partnerSet(partnerSettings),
      inForce: binding.inForce(partnerSettings),
      platformDefault: entry.platformDefault ?? null,
      sealed: entry.secret,
      counts: counts.get(entry.id) ?? null,
    };
    if (entry.qualifier) dto.qualifier = entry.qualifier;
    return dto;
  });

  return { tab, orgCount, fields };
}
