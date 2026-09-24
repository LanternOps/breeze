import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices, discoveredAssets } from '../../db/schema';

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Structural executor shared by the ambient `db` proxy and a real Drizzle
 * transaction. The caller owns the transaction and tenant (RLS) context —
 * this module never opens a transaction or escalates scope itself.
 */
export type BmcLinkTx = Pick<DbTx, 'select' | 'update'>;

export type BmcLinkStatus = 'linked' | 'already_linked' | 'suppressed' | 'no_asset' | 'other_site';

export type BmcReport = {
  deviceId: string;
  orgId: string;
  siteId: string | null;
  mac: string;
  ip: string | null;
};

export type BmcCandidate = {
  id: string;
  orgId: string;
  siteId: string | null;
  macAddress: string | null;
  ipAddress: string | null;
  linkedDeviceId: string | null;
  autoLinkSuppressedAt: Date | null;
};

/**
 * Normalizes a reported MAC into a bare lowercase 12-hex-digit string, or
 * null when the input isn't a plausible individual unicast MAC (accepts
 * colon, dash, and Cisco dot notation). Rejects the all-zero and
 * broadcast/multicast addresses — neither can identify a specific asset.
 */
export function normalizeBmcMac(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (
    !/^(?:[0-9a-f]{12}|(?:[0-9a-f]{2}:){5}[0-9a-f]{2}|(?:[0-9a-f]{2}-){5}[0-9a-f]{2}|(?:[0-9a-f]{4}\.){2}[0-9a-f]{4})$/.test(
      value,
    )
  ) {
    return null;
  }
  const normalized = value.replace(/[:.-]/g, '');
  return normalized === '000000000000' || (parseInt(normalized.slice(0, 2), 16) & 1) !== 0
    ? null
    : normalized;
}

/**
 * Pure decision matrix: given the candidate discovered_assets rows already
 * scoped to the report's org + normalized MAC, decides whether/what to link.
 * IP never establishes identity on its own — it only disambiguates when
 * multiple same-org, same-MAC candidates remain after the site filter.
 */
export function chooseBmcAsset(
  rows: BmcCandidate[],
  report: BmcReport,
): { status: BmcLinkStatus; asset?: BmcCandidate } {
  const mac = normalizeBmcMac(report.mac);
  if (!mac) return { status: 'no_asset' };

  const matching = rows.filter(
    (r) => r.orgId === report.orgId && r.macAddress && normalizeBmcMac(r.macAddress) === mac,
  );
  const same = matching.filter((r) => r.siteId === report.siteId);
  const eligible = same.length ? same : matching.filter((r) => r.siteId === null);

  if (!eligible.length) {
    return matching.length
      ? { status: 'other_site', asset: matching.length === 1 ? matching[0] : undefined }
      : { status: 'no_asset' };
  }

  const byIP = eligible.filter((r) => report.ip !== null && r.ipAddress === report.ip);
  const selected = eligible.length === 1 ? eligible[0] : byIP.length === 1 ? byIP[0] : undefined;
  if (!selected) return { status: 'no_asset' };

  if (selected.autoLinkSuppressedAt) return { status: 'suppressed', asset: selected };
  if (selected.linkedDeviceId) return { status: 'already_linked', asset: selected };
  return { status: 'linked', asset: selected };
}

/** Reads same-org discovered_assets candidates matching a normalized MAC. */
export async function readBmcCandidates(tx: Pick<typeof db, 'select'>, orgId: string, mac: string) {
  const normalized = normalizeBmcMac(mac);
  if (!normalized) return [];
  return tx
    .select()
    .from(discoveredAssets)
    .where(
      and(
        eq(discoveredAssets.orgId, orgId),
        sql`lower(regexp_replace(${discoveredAssets.macAddress}, '[:.-]', '', 'g')) = ${normalized}`,
      ),
    );
}

/**
 * Scoped, idempotent BMC <-> discovered-asset association from an in-band
 * agent report. Never sets approval status or classification — only
 * linkedDeviceId/linkSource. The caller supplies the transaction and tenant
 * (RLS) context; this function never elevates scope.
 */
export async function linkBmcAssetFromAgentReport(
  tx: BmcLinkTx,
  report: BmcReport,
): Promise<BmcLinkStatus> {
  const normalized = normalizeBmcMac(report.mac);
  if (!normalized) return 'no_asset';

  const [device] = await tx
    .select({ id: devices.id, siteId: devices.siteId })
    .from(devices)
    .where(and(eq(devices.id, report.deviceId), eq(devices.orgId, report.orgId)))
    .limit(1)
    .for('share');
  if (!device || device.siteId !== report.siteId) return 'no_asset';

  const rows = await tx
    .select()
    .from(discoveredAssets)
    .where(
      and(
        eq(discoveredAssets.orgId, report.orgId),
        sql`lower(regexp_replace(${discoveredAssets.macAddress}, '[:.-]', '', 'g')) = ${normalized}`,
      ),
    )
    .orderBy(discoveredAssets.id)
    .for('update');

  const choice = chooseBmcAsset(rows, report);
  if (choice.status !== 'linked' || !choice.asset) return choice.status;

  const updated = await tx
    .update(discoveredAssets)
    .set({ linkedDeviceId: report.deviceId, linkSource: 'agent_report', updatedAt: new Date() })
    .where(
      and(
        eq(discoveredAssets.id, choice.asset.id),
        eq(discoveredAssets.orgId, report.orgId),
        isNull(discoveredAssets.linkedDeviceId),
        isNull(discoveredAssets.autoLinkSuppressedAt),
      ),
    )
    .returning({ id: discoveredAssets.id });
  if (!updated.length) throw new Error('BMC link changed while locked');
  return 'linked';
}
