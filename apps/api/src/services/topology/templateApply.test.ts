import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./siteConfiguration', () => ({
  loadTopologyConfiguration: vi.fn(),
  assertConfigurationEffects: vi.fn(),
}));
const { accessMock, authorityMock, storeMocks } = vi.hoisted(() => ({
  accessMock: vi.fn(),
  authorityMock: vi.fn(),
  storeMocks: { applicationRows: vi.fn(), insertApplicationRow: vi.fn() },
}));
vi.mock('../../db', () => ({
  db: {
    execute: vi.fn().mockResolvedValue(undefined),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
  },
  withDbTransaction: vi.fn((fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('./access', async (orig) => ({
  ...(await orig<object>()),
  requireTopologySiteAccess: accessMock,
}));
vi.mock('./templateApplicationAuthority', async (orig) => ({
  ...(await orig<object>()),
  currentApplicationAuthority: authorityMock,
}));
vi.mock('./templateApplicationStore', async (orig) => ({
  ...(await orig<object>()),
  applicationRows: storeMocks.applicationRows,
  insertApplicationRow: storeMocks.insertApplicationRow,
}));
vi.mock('../permissions', async (orig) => ({
  ...(await orig<object>()),
  getPermissionAuthorityVersion: vi.fn().mockResolvedValue('v1'),
}));
import {
  assertEffectCapabilities,
  summarizeTemplateApplication,
  previewTopologyTemplateApplication,
  applyTopologyTemplatePreview,
} from './templateApply';
import { TopologyError } from './access';
import {
  applicationEffectDigest,
  applicationHash,
  applicationId,
} from './templateApplicationStore';
import {
  INTENT_EVENT,
  PREVIEW_EVENT,
  PREVIEW_TTL_MS,
} from './templateApplicationTypes';
import { freezeApplicationActor } from './templateApplicationAuthority';
import type { AuthContext } from '../../middleware/auth';
const id = '00000000-0000-4000-8000-000000000001';
const org = '00000000-0000-4000-8000-000000000010';
const site = '00000000-0000-4000-8000-000000000020';
function requesterAuth(): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id, email: 'operator@example.test' },
    token: { aep: 1, mep: 1, mfa: true },
    accessibleOrgIds: [org],
    scope: 'organization',
    orgId: org,
    partnerId: null,
    canAccessOrg: (candidate: string) => candidate === org,
  } as unknown as AuthContext;
}
const permissions = { permissions: [], scope: 'organization', orgId: org } as never;
beforeEach(() => {
  accessMock.mockReset();
  authorityMock.mockReset();
  storeMocks.applicationRows.mockReset();
  storeMocks.insertApplicationRow.mockReset().mockResolvedValue(undefined);
});
describe('application admission invariants', () => {
  it('rejects recurring activation instead of silently dropping it', async () => {
    await expect(
      assertEffectCapabilities(
        {} as never,
        { targets: {}, policies: {} },
        { targets: {}, policies: {} },
        true,
      ),
    ).rejects.toMatchObject({ code: 'capability_unavailable', status: 409 });
  });
  it('uses requester-bound stable idempotency operation IDs', () => {
    expect(applicationId(id, 'one')).toBe(applicationId(id, 'one'));
    expect(applicationId(id, 'two')).not.toBe(applicationId(id, 'one'));
    expect(applicationId('different', 'one')).not.toBe(
      applicationId(id, 'one'),
    );
  });
  it('summarizes only the supplied visible outcomes', () => {
    expect(
      summarizeTemplateApplication(id, [
        { siteId: id, state: 'applied', code: null, settingsRevision: '1' },
      ]),
    ).toMatchObject({ state: 'completed', sites: [{ siteId: id }] });
    expect(
      summarizeTemplateApplication(id, [
        {
          siteId: id,
          state: 'conflict',
          code: 'permission_changed',
          settingsRevision: null,
        },
      ]).state,
    ).toBe('failed');
  });
  it('binds a preview to ten minutes', () => {
    expect(PREVIEW_TTL_MS).toBe(10 * 60_000);
  });
  it('digests requester, permission version, expiry and every approved effect field', () => {
    const base = {
      actor: { user: { id }, authEpoch: 1, mfaEpoch: 1 } as never,
      permissionVersion: 'v1',
      expiresAt: '2026-09-17T00:10:00.000Z',
      effect: {
        siteId: id,
        expectedBindingRevision: '0',
        expectedSettingsRevision: '0',
        partnerVersionId: null,
        orgVersionId: null,
        overrides: { targets: {}, policies: {} },
        resolvedDigest: 'a'.repeat(64),
        templateRevisions: {},
        enableRecurring: false,
        operationId: id,
      },
    } as Parameters<typeof applicationEffectDigest>[0];
    const baseline = applicationEffectDigest(base);
    expect(applicationEffectDigest(structuredClone(base))).toBe(baseline);
    const mutations: Array<Partial<typeof base>> = [
      { permissionVersion: 'v2' },
      { expiresAt: '2026-09-17T00:11:00.000Z' },
      { actor: { user: { id }, authEpoch: 2, mfaEpoch: 1 } as never },
      { effect: { ...base.effect!, expectedBindingRevision: '1' } },
      { effect: { ...base.effect!, expectedSettingsRevision: '1' } },
      { effect: { ...base.effect!, resolvedDigest: 'b'.repeat(64) } },
      { effect: { ...base.effect!, templateRevisions: { [id]: '1:1:active' } } },
      { effect: { ...base.effect!, enableRecurring: true } },
      {
        effect: {
          ...base.effect!,
          overrides: {
            targets: {},
            policies: {},
            passive: { enabled: true },
          } as never,
        },
      },
      { effect: null },
    ];
    for (const mutation of mutations)
      expect(applicationEffectDigest({ ...base, ...mutation })).not.toBe(
        baseline,
      );
  });
  it('never persists bearer tokens with the approved actor', () => {
    const auth = {
      principal: { kind: 'user_session' },
      user: { id },
      token: { aep: 1, mep: 1, mfa: true, jti: 'do-not-persist' },
      accessibleOrgIds: [id],
      scope: 'organization',
      orgId: id,
      partnerId: id,
    } as AuthContext;
    const actor = freezeApplicationActor(auth);
    expect(actor).not.toHaveProperty('token');
    expect(JSON.stringify(actor)).not.toContain('do-not-persist');
    expect(() =>
      freezeApplicationActor({ ...auth, principal: { kind: 'api_key' } }),
    ).toThrow();
  });
});
describe('template application admission tier', () => {
  it('admits preview at site write, not read', async () => {
    const auth = requesterAuth();
    accessMock.mockRejectedValue(
      new TopologyError('topology_permission_denied', 403, 'denied'),
    );
    authorityMock.mockResolvedValue({ auth, permissions, version: 'v1' });
    await expect(
      previewTopologyTemplateApplication(auth, permissions, {
        partnerVersionId: null,
        orgVersionId: null,
        sites: [
          { siteId: site, expectedBindingRevision: '0', enableRecurring: false },
        ],
      }),
    ).rejects.toBeInstanceOf(TopologyError);
    expect(accessMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      site,
      'write',
    );
    expect(accessMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      site,
      'read',
    );
  });
  it('re-checks site write, not read, before journaling an apply intent', async () => {
    const auth = requesterAuth();
    const actor = freezeApplicationActor(auth);
    const token = 'opaque-preview-token';
    const tokenDigest = applicationHash(token);
    const previewId = applicationId(actor.user.id, tokenDigest);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const effect = {
      siteId: site,
      expectedBindingRevision: '0',
      expectedSettingsRevision: '0',
      partnerVersionId: null,
      orgVersionId: null,
      overrides: { targets: {}, policies: {} },
      resolvedDigest: 'a'.repeat(64),
      templateRevisions: {},
      enableRecurring: false,
      operationId: previewId,
    };
    const preview = {
      siteId: site,
      expectedBindingRevision: '0',
      effects: [],
      errors: [],
    };
    const record = {
      version: 1 as const,
      requesterId: actor.user.id,
      originalOrgId: org,
      actor,
      previewId,
      tokenDigest,
      permissionVersion: 'v1',
      expiresAt,
      effectDigest: applicationEffectDigest({
        effect,
        actor,
        permissionVersion: 'v1',
        expiresAt,
      }),
      effect,
      preview,
    };
    storeMocks.applicationRows.mockImplementation(
      (_aggId: string, _requesterId: string, eventKind: string) =>
        Promise.resolve(
          eventKind === INTENT_EVENT
            ? []
            : [
                {
                  id: 'row-1',
                  orgId: org,
                  siteId: site,
                  aggregateId: previewId,
                  eventKind: PREVIEW_EVENT,
                  payload: record,
                },
              ],
        ),
    );
    authorityMock.mockResolvedValue({ auth, permissions, version: 'v1' });
    accessMock.mockRejectedValue(
      new TopologyError('topology_permission_denied', 403, 'denied'),
    );
    await expect(
      applyTopologyTemplatePreview(auth, permissions, token, 'same-intent'),
    ).rejects.toMatchObject({ code: 'application_not_found' });
    expect(accessMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      site,
      'write',
    );
    expect(accessMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      site,
      'read',
    );
  });
});
