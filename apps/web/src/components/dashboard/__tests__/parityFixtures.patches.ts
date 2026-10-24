// Fixtures for the patch-compliance count-parity family (dashboard wave C,
// #9791). Same two narrowing inputs as the devices families (ambient org + site
// allowlist), imported from parityFixtures. The fake server mirrors
// GET /patches/compliance (apps/api/src/routes/patches/complianceDevices.ts):
//   - summary fields (totalDevices, compliantDevices, devicePercent, counts)
//     describe every counted device in scope and ignore `status`;
//   - `devices` / `devicesPage.total` are the rows matching `status`.
import { ORG_A, ORG_B, SITE_A, SITE_B, SITE_C, type Session } from './parityFixtures';

export interface FixturePatchDevice {
  id: string;
  orgId: string;
  siteId: string;
  pendingPatches: number;
  failedMissing: number;
  criticalMissing: number;
  thirdPartyMissing: number;
  pendingReboot: boolean;
}

const dev = (
  id: string,
  orgId: string,
  siteId: string,
  over: Partial<Omit<FixturePatchDevice, 'id' | 'orgId' | 'siteId'>> = {},
): FixturePatchDevice => ({
  id,
  orgId,
  siteId,
  pendingPatches: 0,
  failedMissing: 0,
  criticalMissing: 0,
  thirdPartyMissing: 0,
  pendingReboot: false,
  ...over,
});

// Device % differs per scenario (org A 2/6 = 33, site A 2/4 = 50, fleet 3/8 = 38)
// so a scope leak changes the headline, not just a row.
export const FIXTURE_PATCH_DEVICES: FixturePatchDevice[] = [
  dev('p1', ORG_A, SITE_A),
  dev('p2', ORG_A, SITE_A, { pendingPatches: 3, criticalMissing: 1, failedMissing: 1 }),
  dev('p3', ORG_A, SITE_A, { pendingPatches: 1, thirdPartyMissing: 1 }),
  dev('p4', ORG_A, SITE_A, { pendingReboot: true }),
  dev('p5', ORG_A, SITE_B, { pendingPatches: 2, failedMissing: 2 }),
  dev('p6', ORG_A, SITE_B, { pendingPatches: 1, criticalMissing: 1 }),
  dev('p7', ORG_B, SITE_C, { pendingPatches: 4, criticalMissing: 2, failedMissing: 1 }),
  dev('p8', ORG_B, SITE_C),
];

const inScope = (d: FixturePatchDevice, s: Session): boolean =>
  (!s.orgId || d.orgId === s.orgId) && (!s.allowedSiteIds || s.allowedSiteIds.includes(d.siteId));

const STATUS: Record<string, (d: FixturePatchDevice) => boolean> = {
  all: () => true,
  compliant: (d) => d.pendingPatches === 0,
  'needs-patches': (d) => d.pendingPatches > 0,
  failed: (d) => d.failedMissing > 0,
  critical: (d) => d.criticalMissing > 0,
  reboot: (d) => d.pendingReboot,
  'third-party': (d) => d.thirdPartyMissing > 0,
};

/** GET /patches/compliance[?status=] for a session, in the API's shape. */
export function patchComplianceFor(s: Session, status: string | null) {
  const rows = FIXTURE_PATCH_DEVICES.filter((d) => inScope(d, s));
  const count = (k: string) => rows.filter(STATUS[k]!).length;
  const compliant = count('compliant');
  const matching = rows.filter(STATUS[status ?? 'all'] ?? (() => false));
  return {
    data: {
      summary: { total: 0, pending: 0, installed: 0, failed: 0, missing: 0, skipped: 0 },
      // The item % deliberately differs from the device % (Decision 4).
      compliancePercent: 97,
      totalDevices: rows.length,
      compliantDevices: compliant,
      criticalSummary: { total: 0, patched: 0, pending: 0 },
      importantSummary: { total: 0, patched: 0, pending: 0 },
      unratedSummary: { total: 0, patched: 0, pending: 0 },
      devicesNeedingPatches: [],
      devicePercent: rows.length ? Math.round((compliant / rows.length) * 100) : 0,
      failedDevices: count('failed'),
      deviceCounts: {
        all: rows.length,
        compliant,
        needsPatches: count('needs-patches'),
        failed: count('failed'),
        critical: count('critical'),
        reboot: count('reboot'),
        thirdParty: count('third-party'),
      },
      outstandingTotals: { patches: 0, approved: 0, unapproved: 0, failed: 0, critical: 0 },
      devices: matching.map((d) => ({
        id: d.id,
        hostname: `host-${d.id}`,
        displayName: null,
        osType: 'windows',
        lastSeenAt: null,
        status: 'online',
        orgId: d.orgId,
        pendingPatches: d.pendingPatches,
        approvedMissing: 0,
        unapprovedMissing: d.pendingPatches - d.failedMissing,
        failedMissing: d.failedMissing,
        criticalMissing: d.criticalMissing,
        importantMissing: 0,
        osMissing: d.pendingPatches - d.thirdPartyMissing,
        thirdPartyMissing: d.thirdPartyMissing,
        staleImages: 0,
        pendingReboot: d.pendingReboot,
        lastInstalledAt: null,
        lastScannedAt: null,
        compliant: d.pendingPatches === 0,
      })),
      devicesPage: { status: status ?? 'all', search: null, limit: 50, offset: 0, total: matching.length },
    },
  };
}

type Payload = ReturnType<typeof patchComplianceFor>;

export interface PatchesParityExpectation {
  /** The `status` the destination must send, or null for none (the KPI). */
  status: string | null;
  /** 'rows': the number equals the destination's row total; 'headline': its device %. */
  grain: 'rows' | 'headline';
  /** The tile's number, from the dashboard's own (status-less) fetch. */
  tileCount: (tile: Payload) => number;
}

/** Every patch `count` entry in DASHBOARD_METRICS (registry coverage reads this). */
export const PATCHES_PARITY: Record<string, PatchesParityExpectation> = {
  'kpi.patchCompliance': { status: null, grain: 'headline', tileCount: (t) => t.data.devicePercent },
  'patch.devicesCompliant': { status: 'compliant', grain: 'rows', tileCount: (t) => t.data.compliantDevices },
  'patch.devicesNonCompliant': {
    status: 'needs-patches',
    grain: 'rows',
    tileCount: (t) => t.data.totalDevices - t.data.compliantDevices,
  },
};

/** Affected links: the destination filter they must land on (no count claim). */
export const PATCHES_AFFECTED: Record<string, string> = {
  'patch.viewPendingDevices': 'needs-patches',
  'patch.viewFailedDevices': 'failed',
  'patch.viewCriticalDevices': 'critical',
};
