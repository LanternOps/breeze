import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { discoveredAssets } from '../../db/schema/discovery';
import type { DbExecutor } from './monitorCompiler';

export class NetworkCheckAssetError extends Error {}

export async function assertNetworkCheckAssetOwner(
  kind: string,
  condition: Record<string, unknown>,
  owner: { orgId: string | null; partnerId: string | null },
  executor: DbExecutor = db,
): Promise<void> {
  if (kind !== 'network_check' || !condition.assetId) return;
  if (!owner.orgId || owner.partnerId) throw new NetworkCheckAssetError('asset_requires_org_owner');

  const [asset] = await executor.select({ id: discoveredAssets.id }).from(discoveredAssets)
    .where(and(eq(discoveredAssets.id, String(condition.assetId)), eq(discoveredAssets.orgId, owner.orgId)))
    .limit(1);
  if (!asset) throw new NetworkCheckAssetError('asset_not_owned');
}
