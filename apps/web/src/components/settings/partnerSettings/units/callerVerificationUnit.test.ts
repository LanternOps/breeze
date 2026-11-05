import '@/lib/i18n';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPolicy, putPolicy, type PolicyResponse } from '@/lib/api/callerVerification';
import { ActionError } from '@/lib/runAction';
import { policy, policyValues } from '../../../callerVerification/testFixtures';
import { usePartnerSettingsDraftStore } from '../partnerSettingsDraftStore';
import {
  inheritedDraft,
  loadCallerVerification,
  useCallerVerificationUnit,
  type CallerVerificationValue,
} from './callerVerificationUnit';

vi.mock('@/lib/api/callerVerification', () => ({ getPolicy: vi.fn(), putPolicy: vi.fn() }));

const response = (over: Partial<PolicyResponse> = {}): PolicyResponse => ({ maxAchievableTier: 3, row: null, defaults: policyValues, baseline: policyValues, effective: policy, ...over });
const store = () => usePartnerSettingsDraftStore.getState();
const slice = () => store().slices.callerVerification as { draft: CallerVerificationValue | null; baseline: CallerVerificationValue | null };

beforeEach(async () => {
  vi.clearAllMocks();
  store().reset();
  store().setPartner('p1');
  vi.mocked(getPolicy).mockResolvedValue(response());
  await store().ensureLoaded('callerVerification', loadCallerVerification);
});

describe('caller verification save unit', () => {
  it('loads the partner baseline with every field as inherit', () => {
    expect(getPolicy).toHaveBeenCalledWith({ ownerScope: 'partner' });
    expect(slice().draft?.draft).toEqual(inheritedDraft());
  });

  it('is clean until the draft changes', () => {
    const { result } = renderHook(() => useCallerVerificationUnit());
    expect(result.current.isDirty()).toBe(false);
    act(() => store().setDraft<CallerVerificationValue>('callerVerification', v => ({ ...v, draft: { ...v.draft, coolingOffHours: 48 } })));
    expect(result.current.isDirty()).toBe(true);
  });

  it('header Save sends the existing request body without a per-unit success toast', async () => {
    const saved = response({ row: { ...inheritedDraft(), coolingOffHours: 48 } });
    vi.mocked(putPolicy).mockResolvedValue(saved);
    store().setDraft<CallerVerificationValue>('callerVerification', v => ({ ...v, draft: { ...v.draft, coolingOffHours: 48 } }));
    const { result } = renderHook(() => useCallerVerificationUnit());
    const outcome = await result.current.save();
    expect(outcome.status).toBe('saved');
    expect(putPolicy).toHaveBeenCalledWith({ ownerScope: 'partner' }, { ...inheritedDraft(), coolingOffHours: 48 }, { silentSuccess: true });
    expect(slice().baseline?.response).toBe(saved);
    expect(result.current.isDirty()).toBe(false);
  });

  it('sends the achievable tier when the stored one is above it', async () => {
    vi.mocked(getPolicy).mockResolvedValue(response({ maxAchievableTier: 2 }));
    await store().reloadFromServer('callerVerification', loadCallerVerification);
    vi.mocked(putPolicy).mockResolvedValue(response());
    store().setDraft<CallerVerificationValue>('callerVerification', v => ({ ...v, draft: { ...v.draft, requiredTierResetPassword: 3 } }));
    const { result } = renderHook(() => useCallerVerificationUnit());
    await result.current.save();
    expect(putPolicy).toHaveBeenCalledWith({ ownerScope: 'partner' }, { ...inheritedDraft(), requiredTierResetPassword: 2 }, { silentSuccess: true });
  });

  it('a failed save keeps the draft', async () => {
    vi.mocked(putPolicy).mockRejectedValue(new ActionError('nope', 500));
    store().setDraft<CallerVerificationValue>('callerVerification', v => ({ ...v, draft: { ...v.draft, coolingOffHours: 48 } }));
    const { result } = renderHook(() => useCallerVerificationUnit());
    expect(await result.current.save()).toEqual({ status: 'failed' });
    expect(slice().draft?.draft.coolingOffHours).toBe(48);
    expect(result.current.isDirty()).toBe(true);
  });
});
