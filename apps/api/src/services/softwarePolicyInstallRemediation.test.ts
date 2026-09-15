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

import { resolvePolicyInstallTarget } from './softwarePolicyInstallRemediation';

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
