/**
 * #5505 W03 — what must be decided BEFORE a policy-owned deployment row exists.
 *
 * The tenancy case is the sharp one. This module runs inside the remediation
 * worker's SYSTEM db context (softwareRemediationWorker.ts:14-22), where
 * breeze_has_org_access short-circuits true and RLS scopes nothing. A rule's
 * catalogId is operator-authored jsonb inside software_policies.rules, so
 * without an explicit ownership predicate a policy could name ANOTHER tenant's
 * catalog item and install that tenant's uploaded binary onto these machines.
 * The WHERE clause IS the entire guard here; there is no second line of defence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: (...a: unknown[]) => selectMock(...a) },
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
  withSystemDbAccessContext: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

const { createSoftwareDeploymentMock } = vi.hoisted(() => ({
  createSoftwareDeploymentMock: vi.fn(async (..._args: any[]) => ({
    deploymentId: 'dep-1',
    deployment: {},
    status: 'pending' as const,
    dispatchedDeviceIds: ['dev-1'],
    deviceResults: [],
  })),
}));
vi.mock('./softwareDeployment', () => ({ createSoftwareDeployment: createSoftwareDeploymentMock }));

import {
  createPolicyOwnedInstallDeployment,
  hasUnfinishedPolicyOwnedInstall,
  readLatestPolicyOwnedInstallByDevice,
  resolvePolicyInstallTarget,
} from './softwarePolicyInstallRemediation';

function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'where', 'limit', 'orderBy', 'returning', 'values', 'for']) p[m] = () => p;
  return p;
}

/** Serves db.select() in this module's fixed order: catalog -> method -> version. */
function primeSelects(...results: unknown[][]) {
  let call = 0;
  selectMock.mockImplementation(() => chain(results[Math.min(call++, results.length - 1)] ?? []));
}

const CATALOG_ROW = { id: 'cat-1', orgId: 'org-1', partnerId: null, integrationProvider: null };

beforeEach(() => vi.clearAllMocks());

describe('resolvePolicyInstallTarget', () => {
  it('refuses a rule with no catalogId without touching the database', async () => {
    primeSelects([]);
    const result = await resolvePolicyInstallTarget({
      catalogId: undefined,
      deviceOrgId: 'org-1',
      deviceOsType: 'windows',
    });
    expect(result).toEqual({ ok: false, reason: 'no_catalog_id' });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('refuses a catalogId the device tenant cannot reach', async () => {
    // The ownership predicate filters it out, so the catalog SELECT returns [].
    primeSelects([]);
    const result = await resolvePolicyInstallTarget({
      catalogId: 'cat-from-another-tenant',
      deviceOrgId: 'org-1',
      deviceOsType: 'windows',
    });
    expect(result).toEqual({ ok: false, reason: 'catalog_item_not_reachable' });
  });

  it('prefers an enabled install method matching the device OS', async () => {
    primeSelects([CATALOG_ROW], [{ id: 'im-win' }]);
    const result = await resolvePolicyInstallTarget({
      catalogId: 'cat-1',
      deviceOrgId: 'org-1',
      deviceOsType: 'windows',
    });
    expect(result).toEqual({
      ok: true,
      target: { kind: 'install_method', catalogId: 'cat-1', installMethodId: 'im-win' },
    });
  });

  it('falls back to the latest version when no install method matches the OS', async () => {
    primeSelects([CATALOG_ROW], [], [{ id: 'sv-1', supportedOs: ['windows'] }]);
    const result = await resolvePolicyInstallTarget({
      catalogId: 'cat-1',
      deviceOrgId: 'org-1',
      deviceOsType: 'windows',
    });
    expect(result).toEqual({
      ok: true,
      target: { kind: 'version', catalogId: 'cat-1', softwareVersionId: 'sv-1' },
    });
  });

  it('treats a null/empty supportedOs as unrestricted', async () => {
    // Only TWO selects happen on linux: catalog, then version. There is no
    // linux install method by construction (software_install_methods.platform
    // is 'windows' | 'macos'), so the method SELECT is skipped entirely — and
    // asserting the call count is what proves that short-circuit, rather than
    // letting an extra primed result silently paper over a wasted query.
    primeSelects([CATALOG_ROW], [{ id: 'sv-1', supportedOs: null }]);
    const result = await resolvePolicyInstallTarget({
      catalogId: 'cat-1',
      deviceOrgId: 'org-1',
      deviceOsType: 'linux',
    });
    expect(result).toMatchObject({ ok: true, target: { kind: 'version', softwareVersionId: 'sv-1' } });
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('refuses when the only version declares a different OS — the cross-platform loop guard', async () => {
    // Without this the worker would create a guaranteed-failing deployment
    // every 15 minutes for every macOS device under a Windows-only policy.
    primeSelects([CATALOG_ROW], [], [{ id: 'sv-1', supportedOs: ['windows'] }]);
    const result = await resolvePolicyInstallTarget({
      catalogId: 'cat-1',
      deviceOrgId: 'org-1',
      deviceOsType: 'macos',
    });
    expect(result).toEqual({ ok: false, reason: 'no_install_target_for_platform' });
  });

  it('refuses a linux device with no version row — there is no linux install method by construction', async () => {
    primeSelects([CATALOG_ROW], []);
    const result = await resolvePolicyInstallTarget({
      catalogId: 'cat-1',
      deviceOrgId: 'org-1',
      deviceOsType: 'linux',
    });
    expect(result).toEqual({ ok: false, reason: 'no_install_target_for_platform' });
    expect(selectMock).toHaveBeenCalledTimes(2);
  });
});

describe('hasUnfinishedPolicyOwnedInstall', () => {
  it('is true when a non-terminal policy-owned result row exists', async () => {
    primeSelects([{ id: 'dr-1' }]);
    await expect(hasUnfinishedPolicyOwnedInstall('pol-1', 'dev-1')).resolves.toBe(true);
  });

  it('is false when the join returns nothing', async () => {
    primeSelects([]);
    await expect(hasUnfinishedPolicyOwnedInstall('pol-1', 'dev-1')).resolves.toBe(false);
  });

  it('excludes exactly completed/failed/cancelled and nothing else', async () => {
    // Asserted on the CONSTANT, not on a serialized drizzle condition: a deep
    // search over a mocked condition also matches deploymentStatusEnum's own
    // enumValues array, which makes such an assertion pass against unfixed code
    // (memory: drizzle_condition_deep_search_matches_enum_values_vacuous).
    const { FINISHED_POLICY_INSTALL_RESULT_STATUSES } = await import(
      './softwarePolicyInstallRemediation'
    );
    expect([...FINISHED_POLICY_INSTALL_RESULT_STATUSES].sort()).toEqual([
      'cancelled',
      'completed',
      'failed',
    ]);
  });
});

describe('createPolicyOwnedInstallDeployment', () => {
  it('creates an immediate install stamped with the policy, under the DEVICE org, with a null actor', async () => {
    await createPolicyOwnedInstallDeployment({
      policyId: 'pol-1',
      policyName: 'Standard workstation build',
      orgId: 'device-org-1',
      deviceId: 'dev-1',
      target: { kind: 'install_method', catalogId: 'cat-1', installMethodId: 'im-1' },
    });

    expect(createSoftwareDeploymentMock).toHaveBeenCalledTimes(1);
    const input = createSoftwareDeploymentMock.mock.calls[0]![0];
    expect(input).toMatchObject({
      orgId: 'device-org-1',
      installMethodId: 'im-1',
      versionMode: 'latest',
      deploymentType: 'install',
      deviceIds: ['dev-1'],
      scheduleType: 'immediate',
      createdBy: null,
      softwarePolicyId: 'pol-1',
      targetType: 'devices',
      targetIds: ['dev-1'],
    });
    // XOR: exactly one target field reaches createSoftwareDeployment, or its
    // guard at softwareDeployment.ts:998-1002 throws.
    expect(input.softwareVersionId).toBeUndefined();
    expect(String(input.name)).toContain('Standard workstation build');
  });

  it('passes a version target as softwareVersionId and never sets installMethodId', async () => {
    await createPolicyOwnedInstallDeployment({
      policyId: 'pol-1',
      policyName: 'P',
      orgId: 'device-org-1',
      deviceId: 'dev-1',
      target: { kind: 'version', catalogId: 'cat-1', softwareVersionId: 'sv-1' },
    });
    const input = createSoftwareDeploymentMock.mock.calls.at(-1)![0];
    expect(input.softwareVersionId).toBe('sv-1');
    expect(input.installMethodId).toBeUndefined();
    expect(input.versionMode).toBeUndefined();
  });
});

describe('readLatestPolicyOwnedInstallByDevice', () => {
  it('returns the LATEST policy-owned deployment timestamp per device', async () => {
    const older = new Date('2026-09-15T09:00:00Z');
    const newer = new Date('2026-09-15T11:00:00Z');
    primeSelects([
      { deviceId: 'dev-1', createdAt: older },
      { deviceId: 'dev-1', createdAt: newer },
      { deviceId: 'dev-2', createdAt: older },
    ]);

    const byDevice = await readLatestPolicyOwnedInstallByDevice('pol-1', ['dev-1', 'dev-2']);

    expect(byDevice.get('dev-1')).toEqual(newer);
    expect(byDevice.get('dev-2')).toEqual(older);
  });

  it('short-circuits on an empty device list without touching the database', async () => {
    primeSelects([]);
    const byDevice = await readLatestPolicyOwnedInstallByDevice('pol-1', []);
    expect(byDevice.size).toBe(0);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('ignores rows with a missing or unusable createdAt rather than storing garbage', async () => {
    primeSelects([
      { deviceId: 'dev-1', createdAt: null },
      { deviceId: 'dev-2', createdAt: 'not-a-date' },
    ]);
    const byDevice = await readLatestPolicyOwnedInstallByDevice('pol-1', ['dev-1', 'dev-2']);
    expect(byDevice.size).toBe(0);
  });
});
