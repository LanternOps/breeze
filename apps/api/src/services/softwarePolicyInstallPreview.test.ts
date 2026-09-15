/**
 * #5505 W06 — the dry-run device count behind PolicyForm's "this will install
 * missing software on ~N device(s)" warning (spec Risks §2, "Fleet-wide first
 * run": arming autoInstall on a broad existing policy could otherwise queue
 * thousands of installs with no warning).
 *
 * Cost bound: resolvePolicyInstallTarget (W03) costs up to 3 DB round trips
 * per call, so calling it once per DEVICE would be O(devices) — exactly what
 * this module exists to avoid on a policy that can resolve thousands of them.
 * It is instead called at most once per (distinct orgId, distinct osType,
 * candidate catalogId) triple: catalog reachability only varies by org, and
 * install-target existence only varies by platform, so grouping resolved
 * devices by (orgId, osType) collapses the common case (one org, a handful of
 * OS types) to a small number of calls regardless of device count. The actual
 * device tally per group is a real SQL COUNT(DISTINCT ...), never a capped
 * fetch-and-.length (the bug this replaces — GET /violations,
 * routes/softwarePolicies.ts, `total: rows.length` after a `.limit(...)`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: (...a: unknown[]) => selectMock(...a) },
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', osType: 'devices.osType' },
  softwareComplianceStatus: {
    deviceId: 'softwareComplianceStatus.deviceId',
    policyId: 'softwareComplianceStatus.policyId',
    violations: 'softwareComplianceStatus.violations',
  },
}));

const { resolveDeviceIdsMock } = vi.hoisted(() => ({ resolveDeviceIdsMock: vi.fn() }));
vi.mock('./featureConfigResolver', () => ({
  resolveDeviceIdsForSoftwarePolicy: (...a: unknown[]) => resolveDeviceIdsMock(...a),
}));

const { resolveTargetMock } = vi.hoisted(() => ({ resolveTargetMock: vi.fn() }));
vi.mock('./softwarePolicyInstallRemediation', () => ({
  resolvePolicyInstallTarget: (...a: unknown[]) => resolveTargetMock(...a),
}));

import { computeInstallPreviewEligibleDeviceCount } from './softwarePolicyInstallPreview';

/** Thenable chain matching this module's fixed `.select().from().where()` shape. */
function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'where']) p[m] = () => p;
  return p;
}

/** Serves db.select() in this module's fixed order: device-meta chunk(s), then one COUNT query per eligible group. */
function primeSelects(...results: unknown[][]) {
  let call = 0;
  selectMock.mockImplementation(() => chain(results[Math.min(call++, results.length - 1)] ?? []));
}

const RULES_ONE_CATALOG = { software: [{ name: 'Zoom', catalogId: 'cat-1' }] };
const RULES_NO_CATALOG = { software: [{ name: 'Zoom' }] };

beforeEach(() => vi.clearAllMocks());

describe('computeInstallPreviewEligibleDeviceCount', () => {
  it('returns 0 without touching the database when no rule has a catalogId', async () => {
    const count = await computeInstallPreviewEligibleDeviceCount({
      policyId: 'pol-1',
      rules: RULES_NO_CATALOG,
    });
    expect(count).toBe(0);
    expect(resolveDeviceIdsMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns 0 without a count query when the policy resolves zero devices', async () => {
    resolveDeviceIdsMock.mockResolvedValue([]);
    const count = await computeInstallPreviewEligibleDeviceCount({
      policyId: 'pol-1',
      rules: RULES_ONE_CATALOG,
    });
    expect(count).toBe(0);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns 0 without a count query when the caller site allowlist excludes every resolved device', async () => {
    resolveDeviceIdsMock.mockResolvedValue(['dev-1', 'dev-2']);
    const count = await computeInstallPreviewEligibleDeviceCount({
      policyId: 'pol-1',
      rules: RULES_ONE_CATALOG,
      siteAllowedDeviceIds: [],
    });
    expect(count).toBe(0);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('counts eligible devices for a single (org, os) group via a real COUNT query', async () => {
    resolveDeviceIdsMock.mockResolvedValue(['dev-1', 'dev-2']);
    resolveTargetMock.mockResolvedValue({
      ok: true,
      target: { kind: 'install_method', catalogId: 'cat-1', installMethodId: 'im-1' },
    });
    primeSelects(
      [
        { id: 'dev-1', orgId: 'org-1', osType: 'windows' },
        { id: 'dev-2', orgId: 'org-1', osType: 'windows' },
      ],
      [{ count: 2 }],
    );

    const count = await computeInstallPreviewEligibleDeviceCount({
      policyId: 'pol-1',
      rules: RULES_ONE_CATALOG,
    });

    expect(count).toBe(2);
    expect(resolveTargetMock).toHaveBeenCalledWith({
      catalogId: 'cat-1',
      deviceOrgId: 'org-1',
      deviceOsType: 'windows',
    });
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('skips the count query entirely for a group where no rule resolves — the cross-platform loop guard', async () => {
    resolveDeviceIdsMock.mockResolvedValue(['dev-1']);
    resolveTargetMock.mockResolvedValue({ ok: false, reason: 'no_install_target_for_platform' });
    primeSelects([{ id: 'dev-1', orgId: 'org-1', osType: 'linux' }]);

    const count = await computeInstallPreviewEligibleDeviceCount({
      policyId: 'pol-1',
      rules: RULES_ONE_CATALOG,
    });

    expect(count).toBe(0);
    // Only the device-meta select ran; no per-group count query followed.
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('sums across multiple (org, os) groups independently, skipping ineligible ones', async () => {
    resolveDeviceIdsMock.mockResolvedValue(['dev-win', 'dev-mac']);
    resolveTargetMock.mockImplementation(async ({ deviceOsType }: { deviceOsType: string }) =>
      deviceOsType === 'windows'
        ? { ok: true, target: { kind: 'install_method', catalogId: 'cat-1', installMethodId: 'im-1' } }
        : { ok: false, reason: 'no_install_target_for_platform' },
    );
    primeSelects(
      [
        { id: 'dev-win', orgId: 'org-1', osType: 'windows' },
        { id: 'dev-mac', orgId: 'org-1', osType: 'macos' },
      ],
      [{ count: 1 }],
    );

    const count = await computeInstallPreviewEligibleDeviceCount({
      policyId: 'pol-1',
      rules: RULES_ONE_CATALOG,
    });

    expect(count).toBe(1);
    // Device-meta select + exactly ONE count query (windows group only — the
    // macos group had zero eligible catalogIds and never reached a query).
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('stays bounded by (org, os) groups, not by device count — the load-bearing cost guard', async () => {
    // 800 devices in one org across two OS types. A per-device implementation
    // would call resolvePolicyInstallTarget 800 times (up to 2,400 DB round
    // trips); the grouped one calls it twice — once per (org, os) group — for
    // this policy's single candidate catalogId.
    const deviceRows = Array.from({ length: 800 }, (_, i) => ({
      id: `dev-${i}`,
      orgId: 'org-1',
      osType: i % 2 === 0 ? 'windows' : 'macos',
    }));
    resolveDeviceIdsMock.mockResolvedValue(deviceRows.map((d) => d.id));
    resolveTargetMock.mockResolvedValue({
      ok: true,
      target: { kind: 'install_method', catalogId: 'cat-1', installMethodId: 'im-1' },
    });
    // 800 ids chunk into 2 device-meta selects (chunk size 500); each of the
    // two 400-device groups then costs a single count query.
    let call = 0;
    selectMock.mockImplementation(() => {
      const i = call++;
      if (i === 0) return chain(deviceRows.slice(0, 500));
      if (i === 1) return chain(deviceRows.slice(500));
      return chain([{ count: 400 }]);
    });

    const count = await computeInstallPreviewEligibleDeviceCount({
      policyId: 'pol-1',
      rules: RULES_ONE_CATALOG,
    });

    expect(count).toBe(800);
    expect(resolveTargetMock).toHaveBeenCalledTimes(2);
    // 2 device-meta chunks + 2 group count queries. Emphatically NOT O(800).
    expect(selectMock).toHaveBeenCalledTimes(4);
  });
});
