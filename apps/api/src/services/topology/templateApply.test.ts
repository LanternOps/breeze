import { describe, expect, it, vi } from 'vitest';
vi.mock('./siteConfiguration', () => ({
  loadTopologyConfiguration: vi.fn(),
  assertConfigurationEffects: vi.fn(),
}));
import {
  assertEffectCapabilities,
  summarizeTemplateApplication,
} from './templateApply';
import {
  applicationEffectDigest,
  applicationId,
} from './templateApplicationStore';
import { PREVIEW_TTL_MS } from './templateApplicationTypes';
import { freezeApplicationActor } from './templateApplicationAuthority';
import type { AuthContext } from '../../middleware/auth';
const id = '00000000-0000-4000-8000-000000000001';
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
