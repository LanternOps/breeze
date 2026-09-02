import { beforeEach, describe, expect, it, vi } from 'vitest';

const lineageRows = vi.hoisted(() => [] as Array<Array<{
  orgId: string;
  deviceId: string | null;
  siteId: string | null;
}>>);

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const rows = lineageRows.shift() ?? [];
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.leftJoin = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(async () => rows);
      return chain;
    }),
  },
}));

import {
  ResilienceAuthorizationError,
  authorizeResilienceResources,
  type AuthorizationPrincipal,
  type ResilienceResourceRef,
} from './resilienceSiteAuthorization';

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const SOURCE_DEVICE = '33333333-3333-4333-8333-333333333333';
const TARGET_DEVICE = '44444444-4444-4444-8444-444444444444';
const RESTORE_JOB = '55555555-5555-4555-8555-555555555555';

function principal(
  allowedSiteIds: string[] | undefined,
  crossSite = false,
  kind: AuthorizationPrincipal['kind'] = 'user_session',
): AuthorizationPrincipal {
  return {
    kind,
    permissions: {
      permissions: crossSite
        ? [{ resource: 'backup', action: 'cross_site_restore' }]
        : [],
      partnerId: null,
      orgId: ORG_ID,
      roleId: '66666666-6666-4666-8666-666666666666',
      scope: 'organization',
      allowedSiteIds,
    },
  } as AuthorizationPrincipal;
}

const sourceRef: ResilienceResourceRef = {
  kind: 'snapshot',
  id: '77777777-7777-4777-8777-777777777777',
  role: 'source',
};
const targetRef: ResilienceResourceRef = {
  kind: 'device',
  id: TARGET_DEVICE,
  role: 'target',
};

function queueLineage(...rows: Array<{ orgId?: string; deviceId: string | null; siteId: string | null }>) {
  for (const row of rows) {
    lineageRows.push([{ orgId: row.orgId ?? ORG_ID, deviceId: row.deviceId, siteId: row.siteId }]);
  }
}

async function expectDenied(promise: Promise<unknown>, status: 403 | 404, code: string) {
  await expect(promise).rejects.toMatchObject({ status, code });
  await promise.catch((error: unknown) => {
    expect(error).toBeInstanceOf(ResilienceAuthorizationError);
    expect((error as Error).message).toBe(code);
    expect((error as Error).message).not.toContain(SOURCE_DEVICE);
    expect((error as Error).message).not.toContain(TARGET_DEVICE);
    expect((error as Error).message).not.toContain(SITE_A);
    expect((error as Error).message).not.toContain(SITE_B);
  });
}

describe('authorizeResilienceResources', () => {
  beforeEach(() => {
    lineageRows.length = 0;
  });

  it('allows source and target lineage in the same authorized site', async () => {
    queueLineage(
      { deviceId: SOURCE_DEVICE, siteId: SITE_A },
      { deviceId: TARGET_DEVICE, siteId: SITE_A },
    );

    const result = await authorizeResilienceResources({
      orgId: ORG_ID,
      principal: principal([SITE_A]),
      refs: [sourceRef, targetRef],
      operation: 'restore',
    });

    expect(result).toEqual({
      resources: [
        { ...sourceRef, orgId: ORG_ID, deviceId: SOURCE_DEVICE, siteId: SITE_A },
        { ...targetRef, orgId: ORG_ID, deviceId: TARGET_DEVICE, siteId: SITE_A },
      ],
    });
  });

  it('denies when the source site is outside the principal grant', async () => {
    queueLineage(
      { deviceId: SOURCE_DEVICE, siteId: SITE_B },
      { deviceId: TARGET_DEVICE, siteId: SITE_A },
    );

    await expectDenied(authorizeResilienceResources({
      orgId: ORG_ID,
      principal: principal([SITE_A]),
      refs: [sourceRef, targetRef],
      operation: 'restore',
    }), 403, 'site_access_denied');
  });

  it('denies when the target site is outside the principal grant', async () => {
    queueLineage(
      { deviceId: SOURCE_DEVICE, siteId: SITE_A },
      { deviceId: TARGET_DEVICE, siteId: SITE_B },
    );

    await expectDenied(authorizeResilienceResources({
      orgId: ORG_ID,
      principal: principal([SITE_A]),
      refs: [sourceRef, targetRef],
      operation: 'restore',
    }), 403, 'site_access_denied');
  });

  it('fails closed when a known resource has no complete device/site lineage', async () => {
    queueLineage({ deviceId: SOURCE_DEVICE, siteId: null });

    await expectDenied(authorizeResilienceResources({
      orgId: ORG_ID,
      principal: principal(undefined),
      refs: [sourceRef],
      operation: 'read',
    }), 403, 'site_access_denied');
  });

  it('denies a cross-site restore even when both sites are granted but the explicit permission is absent', async () => {
    queueLineage(
      { deviceId: SOURCE_DEVICE, siteId: SITE_A },
      { deviceId: TARGET_DEVICE, siteId: SITE_B },
    );

    await expectDenied(authorizeResilienceResources({
      orgId: ORG_ID,
      principal: principal([SITE_A, SITE_B]),
      refs: [sourceRef, targetRef],
      operation: 'restore',
    }), 403, 'site_access_denied');
  });

  it('allows a cross-site restore only with both site grants and backup:cross_site_restore', async () => {
    queueLineage(
      { deviceId: SOURCE_DEVICE, siteId: SITE_A },
      { deviceId: TARGET_DEVICE, siteId: SITE_B },
    );

    const result = await authorizeResilienceResources({
      orgId: ORG_ID,
      principal: principal([SITE_A, SITE_B], true),
      refs: [sourceRef, targetRef],
      operation: 'restore',
    });

    expect(result.resources.map(({ role, deviceId, siteId }) => ({ role, deviceId, siteId }))).toEqual([
      { role: 'source', deviceId: SOURCE_DEVICE, siteId: SITE_A },
      { role: 'target', deviceId: TARGET_DEVICE, siteId: SITE_B },
    ]);
  });

  it('resolves a restore-job target device to its site for cancel/revoke instead of comparing the device id as a site id', async () => {
    queueLineage({ deviceId: TARGET_DEVICE, siteId: SITE_A });

    const result = await authorizeResilienceResources({
      orgId: ORG_ID,
      principal: principal([SITE_A]),
      refs: [{ kind: 'restore_job', id: RESTORE_JOB, role: 'target' }],
      operation: 'revoke',
    });

    expect(result.resources[0]).toMatchObject({ deviceId: TARGET_DEVICE, siteId: SITE_A });
  });

  it('uses explicit principal-kind policy rather than treating allowedSiteIds presence as restriction for system work', async () => {
    queueLineage({ deviceId: TARGET_DEVICE, siteId: SITE_B });

    await expect(authorizeResilienceResources({
      orgId: ORG_ID,
      principal: principal([], false, 'system'),
      refs: [targetRef],
      operation: 'verify',
    })).resolves.toMatchObject({ resources: [{ siteId: SITE_B }] });
  });

  it('returns the same metadata-free 404 for missing and foreign-organization resources', async () => {
    lineageRows.push([]);
    await expectDenied(authorizeResilienceResources({
      orgId: ORG_ID,
      principal: principal([SITE_A]),
      refs: [sourceRef],
      operation: 'read',
    }), 404, 'resource_not_found');

    lineageRows.push([]);
    await expectDenied(authorizeResilienceResources({
      orgId: ORG_ID,
      principal: principal([SITE_A]),
      refs: [{ ...sourceRef, id: '88888888-8888-4888-8888-888888888888' }],
      operation: 'read',
    }), 404, 'resource_not_found');
  });
});
