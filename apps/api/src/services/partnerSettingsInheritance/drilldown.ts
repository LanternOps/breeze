/**
 * Drill-down for one catalog field (#9170, spec §5.4, §5.6): the orgs behind a
 * count, keyset-paginated on (lower(name), id).
 *
 * Population = caller-visible orgs ∧ `bucketSql(bucket)`, applied BEFORE the
 * keyset LIMIT (limit + 1 rows fetched for the lookahead). Rows select only the
 * binding's own expression; `classifyOrg` labels them in memory (≤50 per page)
 * and `project()` shapes each value, so secret fields leave as `{ set }` only.
 * Field ids are looked up in the catalog, never interpolated.
 */
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  CATALOG_BY_ID,
  type CatalogEntry,
  type InheritanceOrgPageDto,
  type InheritanceOrgRowDto,
  type InheritanceOwnValueDto,
} from '@breeze/shared';
import { db } from '../../db';
import { organizations } from '../../db/schema/orgs';
import { notificationChannels } from '../../db/schema/alerts';
import {
  InheritanceBadRequest,
  InheritanceNotFound,
  PUSHOVER_CHANNELS_FROM,
  PUSHOVER_CHANNELS_WHERE,
  orgSourceFrom,
  readPartnerSettings,
  requireAccessibleOrgIds,
  visibleOrgsSql,
  type InheritanceContext,
} from './aggregate';
import { BINDINGS, type Bucket, type FieldBinding } from './bindings';
import { classifyChannel, classifyOrg, type ChannelRaw } from './classify';

export const DRILLDOWN_MAX_LIMIT = 50;

// PostgreSQL rejects NUL in a text parameter; refuse it here as a bad cursor.
const cursorSchema = z.tuple([z.string().max(1024).refine((s) => !s.includes('\u0000')), z.string().uuid()]);
type Cursor = z.infer<typeof cursorSchema>;

/** Opaque base64url of `[lower(name), id]`. */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InheritanceBadRequest('Invalid cursor');
  }
  const result = cursorSchema.safeParse(parsed);
  if (!result.success) throw new InheritanceBadRequest('Invalid cursor');
  return result.data;
}

export interface DrilldownPage {
  bucket: Bucket;
  cursor: string | null;
  limit: number;
}

interface OrgRow {
  id: string;
  name: string;
  sort_name: string;
  present?: boolean;
  value?: unknown;
}

interface ChannelRow {
  id: string;
  name: string;
  org_id: string;
  present: boolean;
  value: unknown;
}

function ownValueDto(entry: CatalogEntry, binding: FieldBinding, set: boolean, raw: unknown): InheritanceOwnValueDto {
  if (!set || entry.secret) return { set };
  const value = binding.project(raw);
  return value === undefined ? { set } : { set, value };
}

export async function listFieldOrgs(
  fieldId: string,
  ctx: InheritanceContext,
  page: DrilldownPage,
): Promise<InheritanceOrgPageDto> {
  const entry = CATALOG_BY_ID[fieldId];
  const binding = entry ? BINDINGS[fieldId] : undefined;
  if (!entry || !binding) throw new InheritanceNotFound('Unknown setting');
  const source = binding.orgSource;
  if (!source || !binding.valueSql) throw new InheritanceBadRequest('This setting has no org-level value');

  const limit = Math.min(Math.max(1, Math.trunc(page.limit)), DRILLDOWN_MAX_LIMIT);
  const cursor = page.cursor ? decodeCursor(page.cursor) : null;
  const accessibleOrgIds = requireAccessibleOrgIds(ctx);
  const { settings: partnerSettings } = await readPartnerSettings(ctx, accessibleOrgIds);

  const predicate = binding.bucketSql(page.bucket, partnerSettings);
  if (!predicate) throw new InheritanceBadRequest('This count is not available for this setting');

  const conditions: SQL[] = [visibleOrgsSql(accessibleOrgIds)];
  if (cursor) {
    conditions.push(sql`(lower(${organizations.name}), ${organizations.id}) > (${cursor[0]}, ${cursor[1]}::uuid)`);
  }

  const isChannels = source.kind === 'pushoverChannels';
  let query: SQL;
  if (isChannels) {
    conditions.push(sql`EXISTS (SELECT 1 FROM ${PUSHOVER_CHANNELS_FROM}
      WHERE ${PUSHOVER_CHANNELS_WHERE} AND ${notificationChannels.orgId} = ${organizations.id} AND ${predicate})`);
    query = sql`SELECT ${organizations.id} AS id, ${organizations.name} AS name, lower(${organizations.name}) AS sort_name
      FROM ${organizations}
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY lower(${organizations.name}), ${organizations.id}
      LIMIT ${limit + 1}`;
  } else {
    conditions.push(predicate);
    query = sql`SELECT ${organizations.id} AS id, ${organizations.name} AS name, lower(${organizations.name}) AS sort_name,
        (${binding.valueSql}) IS NOT NULL AS present, ${binding.valueSql} AS value
      FROM ${orgSourceFrom(source.kind)}
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY lower(${organizations.name}), ${organizations.id}
      LIMIT ${limit + 1}`;
  }

  const fetched = (await db.execute(query)) as unknown as OrgRow[];
  const pageRows = fetched.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  const nextCursor = fetched.length > limit && last ? encodeCursor([last.sort_name, last.id]) : null;

  if (!isChannels) {
    const rows: InheritanceOrgRowDto[] = pageRows.map((row) => {
      const raw = row.present ? row.value : undefined;
      const label = classifyOrg(entry, partnerSettings, raw);
      return {
        orgId: row.id,
        orgName: row.name,
        ownValue: ownValueDto(entry, binding, label.ownValue, raw),
        inEffect: label.inEffect,
      };
    });
    return { field: fieldId, rows, nextCursor };
  }

  // Channel-sourced: list every Pushover channel of the page's orgs.
  const orgIds = pageRows.map((row) => row.id);
  const channelRows = orgIds.length === 0
    ? []
    : ((await db.execute(sql`SELECT ${notificationChannels.id} AS id, ${notificationChannels.name} AS name,
          ${notificationChannels.orgId} AS org_id, (${binding.valueSql}) IS NOT NULL AS present, ${binding.valueSql} AS value
        FROM ${PUSHOVER_CHANNELS_FROM}
        WHERE ${PUSHOVER_CHANNELS_WHERE} AND ${notificationChannels.orgId} IN (${sql.join(orgIds.map((id) => sql`${id}::uuid`), sql`, `)})
        ORDER BY ${notificationChannels.name}, ${notificationChannels.id}`)) as unknown as ChannelRow[]);

  const rows: InheritanceOrgRowDto[] = pageRows.map((row) => {
    const channels = channelRows.filter((channel) => channel.org_id === row.id);
    const raws: ChannelRaw[] = channels.map((channel) => ({ value: channel.present ? channel.value : undefined }));
    const label = classifyOrg(entry, partnerSettings, raws);
    return {
      orgId: row.id,
      orgName: row.name,
      ownValue: { set: label.ownValue },
      inEffect: label.inEffect,
      channels: channels.map((channel, index) => {
        const channelLabel = classifyChannel(entry, partnerSettings, raws[index]!);
        return {
          channelId: channel.id,
          name: channel.name,
          ownValue: ownValueDto(entry, binding, channelLabel.ownValue, raws[index]!.value),
        };
      }),
    };
  });
  return { field: fieldId, rows, nextCursor };
}
