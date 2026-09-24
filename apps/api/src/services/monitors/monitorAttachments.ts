import { and, eq } from 'drizzle-orm';
import { monitorsInheritanceSchema, type MonitorsInheritance } from '@breeze/shared';
import { db } from '../../db';
import { configPolicyFeatureLinks, configPolicyMonitors } from '../../db/schema';

export interface MonitorAttachmentItem {
  monitorId: string;
  enabled: boolean;
  overrides: Record<string, unknown> | null;
  sortOrder: number;
}

export interface MonitorsLinkState {
  linkId: string | null;
  items: MonitorAttachmentItem[];
  inheritance: MonitorsInheritance;
}

/**
 * A policy's monitors link as attach/detach see it, shared by the REST route
 * and the AI tool so the two cannot drift.
 *
 * Items come from the NORMALIZED rows rather than the link's inline settings:
 * the child table is what the resolver and the compatibility trigger see.
 * `inheritance` is the exception. It belongs to the link, not to any
 * attachment, and the resolver reads it from the inline settings — so every
 * rewrite of those settings must carry it forward (see `monitorsLinkSettings`),
 * or a `replace` policy silently becomes `cumulative`.
 */
export async function readMonitorsLink(configPolicyId: string): Promise<MonitorsLinkState> {
  const [link] = await db
    .select({ id: configPolicyFeatureLinks.id, inlineSettings: configPolicyFeatureLinks.inlineSettings })
    .from(configPolicyFeatureLinks)
    .where(
      and(
        eq(configPolicyFeatureLinks.configPolicyId, configPolicyId),
        eq(configPolicyFeatureLinks.featureType, 'monitors'),
      ),
    )
    .limit(1);
  if (!link) return { linkId: null, items: [], inheritance: 'cumulative' };

  const rows = await db
    .select({
      monitorId: configPolicyMonitors.monitorId,
      enabled: configPolicyMonitors.enabled,
      overrides: configPolicyMonitors.overrides,
      sortOrder: configPolicyMonitors.sortOrder,
    })
    .from(configPolicyMonitors)
    .where(eq(configPolicyMonitors.featureLinkId, link.id))
    .orderBy(configPolicyMonitors.sortOrder);

  return {
    linkId: link.id,
    inheritance: monitorsInheritanceSchema
      .catch('cumulative')
      .parse((link.inlineSettings as { inheritance?: unknown } | null)?.inheritance),
    items: rows.map((r) => ({
      monitorId: r.monitorId,
      enabled: r.enabled,
      overrides: (r.overrides as Record<string, unknown> | null) ?? null,
      sortOrder: r.sortOrder,
    })),
  };
}

/** The inline settings to write for `items`, keeping the link's inheritance. */
export function monitorsLinkSettings(items: MonitorAttachmentItem[], inheritance: MonitorsInheritance) {
  return { items, inheritance };
}

/**
 * Whether detaching down to `remaining` items should delete the link. An empty
 * cumulative link contributes nothing, so it goes. An empty `replace` link is
 * kept: it is how a policy blocks every monitor its parents would contribute.
 */
export function shouldRemoveEmptiedLink(remaining: MonitorAttachmentItem[], inheritance: MonitorsInheritance): boolean {
  return remaining.length === 0 && inheritance === 'cumulative';
}
