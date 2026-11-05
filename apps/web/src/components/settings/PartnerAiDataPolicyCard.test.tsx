import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key) }) }));
const runAction = vi.hoisted(() => vi.fn());
vi.mock('@/lib/runAction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/runAction')>('@/lib/runAction');
  return { ...actual, runAction };
});
const fetchWithAuth = vi.hoisted(() => vi.fn());
const handleSessionExpired = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth', () => ({ fetchWithAuth, handleSessionExpired }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import PartnerAiDataPolicyCard from './PartnerAiDataPolicyCard';
import { ActionError } from '@/lib/runAction';
import { usePartnerSettingsDraftStore } from './partnerSettings/partnerSettingsDraftStore';
import { useAiDataPolicyUnit } from './partnerSettings/units/aiDataPolicyUnit';

const defaults = { deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: 30 };
function respond(canManage: boolean, policy: Record<string, unknown> | null) {
  fetchWithAuth.mockImplementation(async () => ({ ok: true, json: async () => ({ policy, canManage, defaults }) }));
}
const unit = () => renderHook(() => useAiDataPolicyUnit()).result.current;
// W2: the card is a form card; the partner settings header Save runs this unit.
const headerSave = async () => { const u = unit(); let out; await act(async () => { out = await u.save(); }); return out; };
const putBodies = () => fetchWithAuth.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([, init]) => init.body);

beforeEach(() => {
  vi.clearAllMocks();
  usePartnerSettingsDraftStore.getState().reset();
  runAction.mockImplementation(async (opts: { request: () => Promise<unknown> }) => { await opts.request(); return {}; });
});

describe('PartnerAiDataPolicyCard', () => {
  it('renders the stored values from GET and names the Breeze default on the inherit option', async () => {
    respond(true, { deviceFileReadLevel: 'off', toolOutputRetentionDays: 14 });
    render(<PartnerAiDataPolicyCard />);
    await waitFor(() => expect(screen.getByTestId('partner-ai-data-policy-card')).toBeInTheDocument());
    expect(fetchWithAuth).toHaveBeenCalledWith('/partner/ai/data-policy');
    expect((screen.getByTestId('partner-ai-data-policy-level-off') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('partner-ai-data-policy-retention') as HTMLInputElement).value).toBe('14');
    const inherit = screen.getByTestId('partner-ai-data-policy-level-inherit');
    expect(inherit).toHaveTextContent('aiDataPolicy.partnerInheritDefault');
    expect(inherit).toHaveTextContent('aiDataPolicy.levels.no_user_profiles.label');
    expect(unit().isDirty()).toBe(false);
  });

  it('shows the Breeze default of 30 days (days mode) when no row exists', async () => {
    respond(true, null);
    render(<PartnerAiDataPolicyCard />);
    const input = (await screen.findByTestId('partner-ai-data-policy-retention')) as HTMLInputElement;
    expect(input.value).toBe('30');
    expect(input.disabled).toBe(false);
    expect((screen.getByTestId('partner-ai-data-policy-retention-days-mode') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('partner-ai-data-policy-retention-default')).toHaveTextContent('aiDataPolicy.retentionBreezeDefault');
  });

  it('selects Keep forever with an empty, disabled days field when the row has NULL retention', async () => {
    respond(true, { deviceFileReadLevel: null, toolOutputRetentionDays: null });
    render(<PartnerAiDataPolicyCard />);
    const forever = (await screen.findByTestId('partner-ai-data-policy-retention-forever')) as HTMLInputElement;
    expect(forever.checked).toBe(true);
    const input = screen.getByTestId('partner-ai-data-policy-retention') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.disabled).toBe(true);
  });

  it('data policy radio change does not PUT; the header Save sends the existing body', async () => {
    respond(true, null);
    render(<PartnerAiDataPolicyCard />);
    fireEvent.click(await screen.findByTestId('partner-ai-data-policy-level-any_with_approval'));
    expect(runAction).not.toHaveBeenCalled();
    expect((screen.getByTestId('partner-ai-data-policy-level-any_with_approval') as HTMLInputElement).checked).toBe(true);
    expect(unit().isDirty()).toBe(true);
    expect((await headerSave())).toMatchObject({ status: 'saved' });
    expect(putBodies()).toEqual([JSON.stringify({ deviceFileReadLevel: 'any_with_approval' })]);
    expect(unit().isDirty()).toBe(false);
  });

  it('Keep forever is a draft; the header Save sends null', async () => {
    respond(true, { deviceFileReadLevel: null, toolOutputRetentionDays: 14 });
    render(<PartnerAiDataPolicyCard />);
    fireEvent.click(await screen.findByTestId('partner-ai-data-policy-retention-forever'));
    expect(runAction).not.toHaveBeenCalled();
    await headerSave();
    expect(putBodies()).toEqual([JSON.stringify({ toolOutputRetentionDays: null })]);
  });

  it('a typed retention is sent as a number', async () => {
    respond(true, { deviceFileReadLevel: null, toolOutputRetentionDays: 14 });
    render(<PartnerAiDataPolicyCard />);
    fireEvent.change(await screen.findByTestId('partner-ai-data-policy-retention'), { target: { value: '90' } });
    await headerSave();
    expect(putBodies()).toEqual([JSON.stringify({ toolOutputRetentionDays: 90 })]);
  });

  it('retention days invalid blocks header Save with inline error', async () => {
    respond(true, { deviceFileReadLevel: null, toolOutputRetentionDays: 14 });
    render(<PartnerAiDataPolicyCard />);
    const input = await screen.findByTestId('partner-ai-data-policy-retention');
    fireEvent.change(input, { target: { value: '0' } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('partner-ai-data-policy-retention-error');
    expect(screen.getByTestId('partner-ai-data-policy-retention-error')).toBeInTheDocument();
    expect(unit().validity().aiFeatures).toEqual({ isValid: false, invalidCount: 1, firstInvalidFieldId: 'partner-ai-data-policy-retention' });
    // The draft survives: nothing reverts the field behind the user's back.
    expect((input as HTMLInputElement).value).toBe('0');
  });

  it('a rejected save keeps the draft', async () => {
    respond(true, { deviceFileReadLevel: null, toolOutputRetentionDays: 14 });
    runAction.mockRejectedValueOnce(new ActionError('rejected', 422));
    render(<PartnerAiDataPolicyCard />);
    fireEvent.change(await screen.findByTestId('partner-ai-data-policy-retention'), { target: { value: '999' } });
    expect(await headerSave()).toEqual({ status: 'failed' });
    expect((screen.getByTestId('partner-ai-data-policy-retention') as HTMLInputElement).value).toBe('999');
    expect(unit().isDirty()).toBe(true);
  });

  it('is read-only and never dirty when canManage is false', async () => {
    respond(false, { deviceFileReadLevel: 'off', toolOutputRetentionDays: null });
    render(<PartnerAiDataPolicyCard />);
    const off = (await screen.findByTestId('partner-ai-data-policy-level-off')) as HTMLInputElement;
    expect(off.disabled).toBe(true);
    expect((screen.getByTestId('partner-ai-data-policy-retention') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('partner-ai-data-policy-level-any_with_approval'));
    expect(unit().isDirty()).toBe(false);
    expect(runAction).not.toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });
});
