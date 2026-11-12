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

const defaults = { deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: 30, transcriptRetentionDays: 365 };
const PREVIEW = '/partner/ai/data-policy/transcript-retention-preview';
function respond(canManage: boolean, policy: Record<string, unknown> | null) {
  fetchWithAuth.mockImplementation(async (url: string) => (String(url).startsWith(PREVIEW)
    ? { ok: true, json: async () => ({ eligible: 7, capped: false, enforced: false }) }
    : { ok: true, json: async () => ({ policy, canManage, defaults }) }));
}
const policyGets = () => fetchWithAuth.mock.calls.filter(([u]) => u === '/partner/ai/data-policy' );
const previewUrls = () => fetchWithAuth.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith(PREVIEW));
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
    // One policy read and never a PUT; the transcript preview is a read too.
    expect(policyGets()).toHaveLength(1);
    expect(putBodies()).toEqual([]);
    expect((screen.getByTestId('partner-ai-data-policy-transcript-retention') as HTMLInputElement).disabled).toBe(true);
  });

  describe('technician transcript retention (#4342 W4)', () => {
    it('shows the stored window in days mode, and the 365-day Breeze default when no row exists', async () => {
      respond(true, { deviceFileReadLevel: null, toolOutputRetentionDays: 14, transcriptRetentionDays: 180 });
      const { unmount } = render(<PartnerAiDataPolicyCard />);
      const input = (await screen.findByTestId('partner-ai-data-policy-transcript-retention')) as HTMLInputElement;
      expect(input.value).toBe('180');
      expect((screen.getByTestId('partner-ai-data-policy-transcript-days-mode') as HTMLInputElement).checked).toBe(true);
      unmount();
      usePartnerSettingsDraftStore.getState().reset();
      respond(true, null);
      render(<PartnerAiDataPolicyCard />);
      expect(((await screen.findByTestId('partner-ai-data-policy-transcript-retention')) as HTMLInputElement).value).toBe('365');
    });

    it('an API that omits the field loads the 365-day default, never Keep forever, and never sends it', async () => {
      fetchWithAuth.mockImplementation(async (url: string) => (String(url).startsWith(PREVIEW)
        ? { ok: true, json: async () => ({ eligible: 0, capped: false, enforced: false }) }
        : { ok: true, json: async () => ({
          policy: { deviceFileReadLevel: null, toolOutputRetentionDays: 14 }, canManage: true,
          defaults: { deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: 30 },
        }) }));
      render(<PartnerAiDataPolicyCard />);
      const input = (await screen.findByTestId('partner-ai-data-policy-transcript-retention')) as HTMLInputElement;
      expect(input.value).toBe('365');
      expect((screen.getByTestId('partner-ai-data-policy-transcript-days-mode') as HTMLInputElement).checked).toBe(true);
      fireEvent.click(screen.getByTestId('partner-ai-data-policy-level-off'));
      await headerSave();
      expect(putBodies()).toEqual([JSON.stringify({ deviceFileReadLevel: 'off' })]);
    });

    it('switching back from Keep forever refills the default window', async () => {
      respond(true, { deviceFileReadLevel: null, toolOutputRetentionDays: 14, transcriptRetentionDays: null });
      render(<PartnerAiDataPolicyCard />);
      fireEvent.click(await screen.findByTestId('partner-ai-data-policy-transcript-days-mode'));
      expect((screen.getByTestId('partner-ai-data-policy-transcript-retention') as HTMLInputElement).value).toBe('365');
      expect(unit().validity().aiFeatures).toEqual({ isValid: true, invalidCount: 0, firstInvalidFieldId: null });
    });

    it('selects Keep forever when the row stores NULL', async () => {
      respond(true, { deviceFileReadLevel: null, toolOutputRetentionDays: 14, transcriptRetentionDays: null });
      render(<PartnerAiDataPolicyCard />);
      expect(((await screen.findByTestId('partner-ai-data-policy-transcript-forever')) as HTMLInputElement).checked).toBe(true);
      expect((screen.getByTestId('partner-ai-data-policy-transcript-retention') as HTMLInputElement).disabled).toBe(true);
    });

    it('the draft unit patches only the transcript field', async () => {
      respond(true, { deviceFileReadLevel: null, toolOutputRetentionDays: 14, transcriptRetentionDays: 365 });
      render(<PartnerAiDataPolicyCard />);
      fireEvent.change(await screen.findByTestId('partner-ai-data-policy-transcript-retention'), { target: { value: '90' } });
      expect(unit().isDirty()).toBe(true);
      await headerSave();
      expect(putBodies()).toEqual([JSON.stringify({ transcriptRetentionDays: 90 })]);
    });

    it('Keep forever sends null', async () => {
      respond(true, { deviceFileReadLevel: null, toolOutputRetentionDays: 14, transcriptRetentionDays: 365 });
      render(<PartnerAiDataPolicyCard />);
      fireEvent.click(await screen.findByTestId('partner-ai-data-policy-transcript-forever'));
      await headerSave();
      expect(putBodies()).toEqual([JSON.stringify({ transcriptRetentionDays: null })]);
    });

    it('an invalid transcript window blocks the header Save on its own field', async () => {
      respond(true, { deviceFileReadLevel: null, toolOutputRetentionDays: 14, transcriptRetentionDays: 365 });
      render(<PartnerAiDataPolicyCard />);
      const input = await screen.findByTestId('partner-ai-data-policy-transcript-retention');
      fireEvent.change(input, { target: { value: '0' } });
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(screen.getByTestId('partner-ai-data-policy-transcript-retention-error')).toBeInTheDocument();
      expect(unit().validity().aiFeatures).toEqual({ isValid: false, invalidCount: 1, firstInvalidFieldId: 'partner-ai-data-policy-transcript-retention' });
    });

    it('counts both invalid windows', async () => {
      respond(true, { deviceFileReadLevel: null, toolOutputRetentionDays: 14, transcriptRetentionDays: 365 });
      render(<PartnerAiDataPolicyCard />);
      fireEvent.change(await screen.findByTestId('partner-ai-data-policy-retention'), { target: { value: '0' } });
      fireEvent.change(screen.getByTestId('partner-ai-data-policy-transcript-retention'), { target: { value: '0' } });
      expect(unit().validity().aiFeatures).toEqual({ isValid: false, invalidCount: 2, firstInvalidFieldId: 'partner-ai-data-policy-retention' });
    });

    it('previews the drafted window with the "up to" partner copy, and not at all for Keep forever', async () => {
      respond(true, { deviceFileReadLevel: null, toolOutputRetentionDays: 14, transcriptRetentionDays: 365 });
      render(<PartnerAiDataPolicyCard />);
      const preview = await screen.findByTestId('partner-ai-data-policy-transcript-preview');
      await waitFor(() => expect(preview).toHaveTextContent('transcriptRetention.preview.partnerPending'));
      expect(previewUrls()).toEqual([`${PREVIEW}?days=365`]);
      fireEvent.change(screen.getByTestId('partner-ai-data-policy-transcript-retention'), { target: { value: '120' } });
      await waitFor(() => expect(previewUrls()).toEqual([`${PREVIEW}?days=365`, `${PREVIEW}?days=120`]));
      fireEvent.click(screen.getByTestId('partner-ai-data-policy-transcript-forever'));
      expect(screen.queryByTestId('partner-ai-data-policy-transcript-preview')).toBeNull();
    });
  });
});
