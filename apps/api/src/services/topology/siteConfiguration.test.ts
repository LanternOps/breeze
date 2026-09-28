import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TopologyConfigurationPayload } from '@breeze/shared';
const mocks = vi.hoisted(() => ({ access: vi.fn(), mfa: vi.fn() }));
vi.mock('../../db', () => ({ db: {}, withDbTransaction: vi.fn() }));
vi.mock('./access', () => ({ requireTopologySiteAccess: mocks.access }));
vi.mock('../../middleware/auth', () => ({ hasSatisfiedMfa: mocks.mfa }));
vi.mock('./writes', () => ({
  scopedWrite: vi.fn(),
  expectedRevisionSchema: { parse: vi.fn() },
}));
import { assertConfigurationEffects } from './siteConfiguration';
const ctx = {
  auth: { principal: { kind: 'user_session' } },
  permissions: {},
  scope: { siteId: 'site' },
} as never;
const empty: TopologyConfigurationPayload = {
  targets: {},
  policies: {},
  outboundEnabled: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({});
  mocks.mfa.mockReturnValue(true);
});
describe('configuration effect authority', () => {
  it('permits passive edits with only write authority', async () => {
    await assertConfigurationEffects(ctx, empty, {
      ...empty,
      passive: { enabled: false },
    });
    expect(mocks.access).toHaveBeenCalledTimes(1);
    expect(mocks.mfa).not.toHaveBeenCalled();
  });
  it('requires configure and execute and MFA for outbound changes', async () => {
    await assertConfigurationEffects(ctx, empty, {
      ...empty,
      outboundEnabled: true,
    });
    expect(mocks.access.mock.calls.map((c) => c[3])).toEqual([
      'write',
      'configure',
      'execute',
    ]);
    expect(mocks.mfa).toHaveBeenCalled();
  });
  it('fails closed on missing current MFA', async () => {
    mocks.mfa.mockReturnValue(false);
    await expect(
      assertConfigurationEffects(ctx, empty, {
        ...empty,
        outboundEnabled: true,
      }),
    ).rejects.toMatchObject({ code: 'mfa_required' });
  });
  it('does not treat object serialization order as a stronger effect', async () => {
    await assertConfigurationEffects(
      ctx,
      { ...empty, passive: { enabled: true, neighbors: true } },
      {
        policies: {},
        targets: {},
        outboundEnabled: false,
        passive: { neighbors: true, enabled: true },
      },
    );
    expect(mocks.access).toHaveBeenCalledTimes(1);
  });
  it('accepts recurring activation INTENT only under configure + execute + MFA (arming is separate)', async () => {
    const policy = { kind: 'policy', enabled: true } as const;
    await assertConfigurationEffects(ctx, empty, { ...empty, policies: { policy: policy as never } });
    expect(mocks.access.mock.calls.map((c) => c[3])).toEqual(['write', 'configure', 'execute']);
    mocks.mfa.mockReturnValue(false);
    await expect(
      assertConfigurationEffects(ctx, empty, { ...empty, policies: { policy: policy as never } }),
    ).rejects.toMatchObject({ code: 'mfa_required' });
  });
});
