import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  notificationChannels,
  scripts,
  softwareCatalog,
  softwareVersions,
} from '../db/schema';
import type { NormalizedAutomationAction } from './automationRuntime';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ScriptRow = typeof scripts.$inferSelect;
type CatalogRow = typeof softwareCatalog.$inferSelect;
type VersionRow = typeof softwareVersions.$inferSelect;
type ChannelRow = typeof notificationChannels.$inferSelect;

export type AutomationReferenceOwner =
  | { scope: 'organization'; orgId: string; partnerId: string }
  | { scope: 'partner'; orgId: null; partnerId: string };

export type ResolvedAutomationReferences = {
  scriptsById: Map<string, ScriptRow>;
  softwareCatalogsById: Map<string, CatalogRow>;
  softwareVersionsByCatalogId: Map<string, VersionRow>;
  notificationChannelsById: Map<string, ChannelRow>;
};

export class AutomationReferenceAuthorizationError extends Error {
  readonly code = 'unknown_or_unauthorized_reference' as const;

  constructor() {
    super('Unknown or unauthorized automation reference');
    this.name = 'AutomationReferenceAuthorizationError';
  }
}

function scriptOwnershipCondition(owner: AutomationReferenceOwner): SQL {
  if (owner.scope === 'partner') {
    return or(
      eq(scripts.isSystem, true),
      and(isNull(scripts.orgId), eq(scripts.partnerId, owner.partnerId)),
    ) as SQL;
  }

  return or(
    eq(scripts.isSystem, true),
    and(eq(scripts.orgId, owner.orgId), eq(scripts.partnerId, owner.partnerId)),
    and(isNull(scripts.orgId), eq(scripts.partnerId, owner.partnerId)),
  ) as SQL;
}

function catalogOwnershipCondition(owner: AutomationReferenceOwner): SQL {
  if (owner.scope === 'partner') {
    return and(
      isNull(softwareCatalog.orgId),
      eq(softwareCatalog.partnerId, owner.partnerId),
    ) as SQL;
  }

  return or(
    and(eq(softwareCatalog.orgId, owner.orgId), isNull(softwareCatalog.partnerId)),
    and(isNull(softwareCatalog.orgId), eq(softwareCatalog.partnerId, owner.partnerId)),
  ) as SQL;
}

function channelOwnershipCondition(owner: AutomationReferenceOwner): SQL {
  if (owner.scope === 'partner') {
    return and(
      isNull(notificationChannels.orgId),
      eq(notificationChannels.partnerId, owner.partnerId),
    ) as SQL;
  }

  return or(
    and(eq(notificationChannels.orgId, owner.orgId), isNull(notificationChannels.partnerId)),
    and(isNull(notificationChannels.orgId), eq(notificationChannels.partnerId, owner.partnerId)),
  ) as SQL;
}

function ownsScript(row: ScriptRow, owner: AutomationReferenceOwner): boolean {
  if (row.isSystem) return true;
  if (owner.scope === 'partner') {
    return row.orgId === null && row.partnerId === owner.partnerId;
  }
  return (
    (row.orgId === owner.orgId && row.partnerId === owner.partnerId)
    || (row.orgId === null && row.partnerId === owner.partnerId)
  );
}

function ownsXorRow(
  row: { orgId: string | null; partnerId: string | null },
  owner: AutomationReferenceOwner,
): boolean {
  if (row.orgId === null) {
    return row.partnerId === owner.partnerId;
  }
  return owner.scope === 'organization'
    && row.orgId === owner.orgId
    && row.partnerId === null;
}

function referencedIds(actions: readonly NormalizedAutomationAction[]) {
  const scriptIds = new Set<string>();
  const catalogIds = new Set<string>();
  const channelIds = new Set<string>();

  for (const action of actions) {
    if (action.type === 'run_script') scriptIds.add(action.scriptId);
    if (action.type === 'deploy_software') catalogIds.add(action.catalogId);
    if (action.type === 'send_notification') channelIds.add(action.notificationChannelId);
  }

  return { scriptIds, catalogIds, channelIds };
}

function assertComplete(requestedIds: ReadonlySet<string>, resolvedIds: ReadonlySet<string>): void {
  if (requestedIds.size !== resolvedIds.size) {
    throw new AutomationReferenceAuthorizationError();
  }
  for (const id of requestedIds) {
    if (!resolvedIds.has(id)) throw new AutomationReferenceAuthorizationError();
  }
}

export async function resolveOwnedAutomationReferences(
  tx: DbTransaction,
  owner: AutomationReferenceOwner,
  targetOrgIds: readonly string[],
  actions: readonly NormalizedAutomationAction[],
  notificationTargets: readonly string[],
): Promise<ResolvedAutomationReferences> {
  // The target org set is deliberately part of the stable resolver contract:
  // later resource kinds may be target-owned. The current four kinds are
  // authorized only against the automation owner, never widened by targets.
  void targetOrgIds;

  const { scriptIds, catalogIds, channelIds } = referencedIds(actions);
  for (const channelId of notificationTargets) channelIds.add(channelId);

  const scriptsById = new Map<string, ScriptRow>();
  const softwareCatalogsById = new Map<string, CatalogRow>();
  const softwareVersionsByCatalogId = new Map<string, VersionRow>();
  const notificationChannelsById = new Map<string, ChannelRow>();

  if (scriptIds.size > 0) {
    const rows = await tx
      .select()
      .from(scripts)
      .where(and(
        inArray(scripts.id, [...scriptIds]),
        isNull(scripts.deletedAt),
        scriptOwnershipCondition(owner),
      ));

    for (const row of rows) {
      if (
        scriptIds.has(row.id)
        && row.deletedAt === null
        && ownsScript(row, owner)
      ) {
        scriptsById.set(row.id, row);
      }
    }
    assertComplete(scriptIds, new Set(scriptsById.keys()));
  }

  if (catalogIds.size > 0) {
    const rows = await tx
      .select({ version: softwareVersions, catalog: softwareCatalog })
      .from(softwareVersions)
      .innerJoin(softwareCatalog, eq(softwareVersions.catalogId, softwareCatalog.id))
      .where(and(
        inArray(softwareVersions.catalogId, [...catalogIds]),
        eq(softwareVersions.isLatest, true),
        catalogOwnershipCondition(owner),
      ));

    for (const row of rows) {
      if (
        row.catalog
        && catalogIds.has(row.catalog.id)
        && row.version.catalogId === row.catalog.id
        && row.version.isLatest
        && ownsXorRow(row.catalog, owner)
      ) {
        softwareCatalogsById.set(row.catalog.id, row.catalog);
        softwareVersionsByCatalogId.set(row.catalog.id, row.version);
      }
    }
    assertComplete(catalogIds, new Set(softwareCatalogsById.keys()));
    assertComplete(catalogIds, new Set(softwareVersionsByCatalogId.keys()));
  }

  if (channelIds.size > 0) {
    const rows = await tx
      .select()
      .from(notificationChannels)
      .where(and(
        inArray(notificationChannels.id, [...channelIds]),
        channelOwnershipCondition(owner),
      ));

    for (const row of rows) {
      if (channelIds.has(row.id) && ownsXorRow(row, owner)) {
        notificationChannelsById.set(row.id, row);
      }
    }
    assertComplete(channelIds, new Set(notificationChannelsById.keys()));
  }

  return {
    scriptsById,
    softwareCatalogsById,
    softwareVersionsByCatalogId,
    notificationChannelsById,
  };
}
