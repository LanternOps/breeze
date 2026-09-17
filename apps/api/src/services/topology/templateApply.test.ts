import { describe, expect, it, vi } from 'vitest';
vi.mock('./siteConfiguration', () => ({
  loadTopologyConfiguration: vi.fn(),
  assertConfigurationEffects: vi.fn(),
}));
import {
  assertEffectCapabilities,
  summarizeTemplateApplication,
} from './templateApply';
import { applicationId } from './templateApplicationStore';
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
