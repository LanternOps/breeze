/**
 * Read/write access to a notification channel's `config` (#6379).
 *
 * `config` lives in `notification_channel_configs`, keyed by channel id, not on
 * `notification_channels`. The child table's RLS is parent OWNERSHIP (system,
 * org access to the parent's org_id, or partner access to its partner_id), so a
 * caller that can SEE a channel only through the partner-wide read branch — an
 * org session looking at its MSP's shared channel — gets `config: null` from
 * the join below instead of the destination and its secrets.
 *
 * `config: null` therefore means "not readable in this DB context" (or, only
 * through a bug, a channel written without its config row). Paths that SEND
 * (notificationDispatcher, automationRuntime) run under system scope and always
 * get the value.
 */
import { and, eq, getTableColumns, inArray, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { notificationChannelConfigs, notificationChannels } from '../db/schema';

export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type NotificationChannelRow = typeof notificationChannels.$inferSelect;

/** A channel row plus its config, or `config: null` when the context cannot read it. */
export type NotificationChannelWithConfig = NotificationChannelRow & { config: unknown };

/**
 * Every channel column plus the config from the child table. A function, not a
 * module-level constant, so importing this module never touches the tables
 * (unit tests partially mock the schema).
 */
export function notificationChannelWithConfigColumns() {
  return {
    ...getTableColumns(notificationChannels),
    config: notificationChannelConfigs.config,
  };
}

/**
 * SELECT channels (optionally filtered) LEFT JOINed to their config row. A LEFT
 * join, not INNER: a channel the context can see but not own must still come
 * back — with `config: null` — so listings keep showing inherited channels.
 */
export async function selectNotificationChannelsWithConfig(
  where: SQL | undefined,
  options: { executor?: DbExecutor; limit?: number; orderBy?: Array<SQL | PgColumn> } = {},
): Promise<NotificationChannelWithConfig[]> {
  const executor = options.executor ?? db;
  const query = executor
    .select(notificationChannelWithConfigColumns())
    .from(notificationChannels)
    .leftJoin(
      notificationChannelConfigs,
      eq(notificationChannelConfigs.channelId, notificationChannels.id),
    )
    .where(where)
    .orderBy(...(options.orderBy ?? []))
    .$dynamic();
  return options.limit !== undefined ? query.limit(options.limit) : query;
}

/** One channel by id (plus any extra predicate), or null. */
export async function getNotificationChannelWithConfig(
  channelId: string,
  options: { executor?: DbExecutor; where?: SQL } = {},
): Promise<NotificationChannelWithConfig | null> {
  const [row] = await selectNotificationChannelsWithConfig(
    options.where ? and(eq(notificationChannels.id, channelId), options.where) : eq(notificationChannels.id, channelId),
    { executor: options.executor, limit: 1 },
  );
  return row ?? null;
}

/** Config values by channel id, for callers that already hold the channel rows. */
export async function loadNotificationChannelConfigs(
  channelIds: readonly string[],
  executor: DbExecutor = db,
): Promise<Map<string, unknown>> {
  if (channelIds.length === 0) return new Map();
  const rows = await executor
    .select({ channelId: notificationChannelConfigs.channelId, config: notificationChannelConfigs.config })
    .from(notificationChannelConfigs)
    .where(inArray(notificationChannelConfigs.channelId, [...channelIds]));
  return new Map(rows.map((row) => [row.channelId, row.config]));
}

/**
 * Insert or replace a channel's config. Callers pass the already-encrypted
 * value (encryptNotificationChannelConfig) and run this in the same transaction
 * as the channel insert/update. RLS WITH CHECK refuses (42501) a caller that
 * does not own the parent channel.
 */
export async function writeNotificationChannelConfig(
  channelId: string,
  config: unknown,
  executor: DbExecutor = db,
): Promise<void> {
  await executor
    .insert(notificationChannelConfigs)
    .values({ channelId, config })
    .onConflictDoUpdate({
      target: notificationChannelConfigs.channelId,
      set: { config },
    });
}
