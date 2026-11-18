// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, renderHook, screen, fireEvent, waitFor } from '@testing-library/react';
import '@/lib/i18n';
const api = vi.hoisted(() => ({ getTrustPageTemplate: vi.fn(), updateTrustPageTemplate: vi.fn() }));
vi.mock('@/lib/api/trustPageTemplate', () => api);
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/shared/Toast', () => ({ showToast: toast }));
vi.mock('@/components/common/RichTextEditor', () => ({
  default: ({ value, onChange, testId }: { value: string; onChange: (h: string) => void; testId: string }) => (
    <textarea data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
import TrustTemplateSettings from './TrustTemplateSettings';
import { usePartnerSettingsDraftStore } from '@/components/settings/partnerSettings/partnerSettingsDraftStore';
import { useTrustCenterUnit } from '@/components/settings/partnerSettings/units/trustCenterUnit';

// W2: the form has no Save of its own; the partner settings header Save runs the trustCenter unit.
const headerSave = async () => {
  const { result } = renderHook(() => useTrustCenterUnit());
  await act(async () => { await result.current.save(); });
};

const DEFAULTS = { introHtml: null, searchIndexable: false, showPercentages: false, showDeviceCount: false, showManagedBy: true, showHistory: false, hiddenControlIds: [], frameworkView: ['nist_csf_2'] };
const EMPTY = { introHtml: null, searchIndexable: null, showPercentages: null, showDeviceCount: null, showManagedBy: null, showHistory: null, hiddenControlIds: null, frameworkView: null };
const OPTIONS = [
  { framework: 'cis_v8', available: false, suggested: false },
  { framework: 'essential_eight', available: true, suggested: true },
  { framework: 'cyber_essentials', available: true, suggested: false },
  { framework: 'nist_csf_2', available: true, suggested: false },
];
const loaded = (over: Record<string, unknown> = {}) => ({ template: null, revision: 0, defaults: DEFAULTS, frameworkOptions: OPTIONS, canManage: true, ...over });
const okSave = (template: unknown, revision: number) => new Response(JSON.stringify({ data: { template, revision } }), { status: 200 });
const sentBody = () => (api.updateTrustPageTemplate.mock.calls.at(-1) as unknown as [unknown, Record<string, unknown>])[1];

describe('TrustTemplateSettings (W02g)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePartnerSettingsDraftStore.getState().reset();
    api.getTrustPageTemplate.mockResolvedValue(loaded());
    api.updateTrustPageTemplate.mockResolvedValue(okSave(EMPTY, 1));
  });

  // #9168: the h-9 select at the default font size clipped its option text.
  it('sizes the on/off selects with the shared h-10 text-sm control style', async () => {
    render(<TrustTemplateSettings />);
    const select = await screen.findByTestId('trust-template-showManagedBy');
    expect(select).toHaveClass('h-10', 'text-sm');
  });

  it('a blank field shows the Breeze default it falls through to', async () => {
    render(<TrustTemplateSettings />);
    const managedBy = await screen.findByTestId('trust-template-showManagedBy');
    expect(managedBy).toHaveValue('inherit');
    expect(screen.getByTestId('trust-template-showManagedBy-inherit')).toHaveTextContent('Breeze default (On)');
    expect(screen.getByTestId('trust-template-showPercentages-inherit')).toHaveTextContent('Breeze default (Off)');
    expect(screen.getByTestId('trust-template-hidden-mode-default')).toBeChecked();
    expect(screen.getByTestId('trust-template-frameworks-mode-default')).toHaveTextContent('NIST CSF 2.0');
  });

  it('the first save sends every field with expectedRevision 0, then holds the returned revision', async () => {
    render(<TrustTemplateSettings />);
    fireEvent.change(await screen.findByTestId('trust-template-showManagedBy'), { target: { value: 'off' } });
    api.updateTrustPageTemplate.mockResolvedValueOnce(okSave({ ...EMPTY, showManagedBy: false }, 1));
    await headerSave();
    await waitFor(() => expect(api.updateTrustPageTemplate).toHaveBeenCalled());
    expect(sentBody()).toEqual({ ...EMPTY, showManagedBy: false, expectedRevision: 0 });

    fireEvent.change(screen.getByTestId('trust-template-showHistory'), { target: { value: 'on' } });
    await headerSave();
    await waitFor(() => expect(api.updateTrustPageTemplate).toHaveBeenCalledTimes(2));
    expect(sentBody()).toMatchObject({ showManagedBy: false, showHistory: true, expectedRevision: 1 });
  });

  it('choosing the Breeze default again clears the field (null)', async () => {
    api.getTrustPageTemplate.mockResolvedValueOnce(loaded({ template: { ...EMPTY, showManagedBy: false }, revision: 3 }));
    render(<TrustTemplateSettings />);
    const sel = await screen.findByTestId('trust-template-showManagedBy');
    expect(sel).toHaveValue('off');
    fireEvent.change(sel, { target: { value: 'inherit' } });
    await headerSave();
    await waitFor(() => expect(api.updateTrustPageTemplate).toHaveBeenCalled());
    expect(sentBody()).toMatchObject({ showManagedBy: null, expectedRevision: 3 });
  });

  it('hidden controls and frameworks: a custom list is sent, the default mode sends null; CIS is not offered while unavailable', async () => {
    render(<TrustTemplateSettings />);
    fireEvent.click(await screen.findByTestId('trust-template-hidden-mode-custom'));
    fireEvent.click(screen.getByTestId('trust-template-hidden-edr_coverage'));
    fireEvent.click(screen.getByTestId('trust-template-frameworks-mode-custom'));
    expect(screen.queryByTestId('trust-template-framework-cis_v8')).toBeNull();
    fireEvent.click(screen.getByTestId('trust-template-framework-essential_eight'));
    await headerSave();
    await waitFor(() => expect(api.updateTrustPageTemplate).toHaveBeenCalled());
    expect(sentBody()).toMatchObject({ hiddenControlIds: ['edr_coverage'], frameworkView: ['essential_eight'] });
  });

  it('a blank intro is null; a written one is sent as is', async () => {
    render(<TrustTemplateSettings />);
    const intro = await screen.findByTestId('trust-template-intro');
    fireEvent.change(intro, { target: { value: '<p></p>' } });
    await headerSave();
    await waitFor(() => expect(api.updateTrustPageTemplate).toHaveBeenCalledTimes(1));
    expect(sentBody().introHtml).toBeNull();
    fireEvent.change(intro, { target: { value: '<p>We watch every device.</p>' } });
    await headerSave();
    await waitFor(() => expect(api.updateTrustPageTemplate).toHaveBeenCalledTimes(2));
    expect(sentBody().introHtml).toBe('<p>We watch every device.</p>');
  });

  it('a stale revision keeps the draft and offers the other admin\'s version (Gate B 11)', async () => {
    render(<TrustTemplateSettings />);
    fireEvent.change(await screen.findByTestId('trust-template-showManagedBy'), { target: { value: 'off' } });
    api.updateTrustPageTemplate.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'stale', code: 'REVISION_MISMATCH' }), { status: 409 }));
    await headerSave();
    expect(await screen.findByTestId('partner-settings-trust-conflict')).toBeInTheDocument();
    expect(screen.getByTestId('trust-template-showManagedBy')).toHaveValue('off');
    expect(api.getTrustPageTemplate).toHaveBeenCalledTimes(1);
    api.getTrustPageTemplate.mockResolvedValueOnce(loaded({ template: { ...EMPTY, showHistory: true }, revision: 7 }));
    fireEvent.click(screen.getByRole('button', { name: /reload theirs/i }));
    await waitFor(() => expect(screen.getByTestId('trust-template-showHistory')).toHaveValue('on'));
    // Their copy replaced the draft, so there is nothing left to save.
    expect(renderHook(() => useTrustCenterUnit()).result.current.isDirty()).toBe(false);
    expect(usePartnerSettingsDraftStore.getState().slices.trustCenter.revision).toBe(7);
  });

  it('a failed save is toasted: a network error with the fallback, a partner-wide 403 with the read-only reason', async () => {
    render(<TrustTemplateSettings />);
    fireEvent.change(await screen.findByTestId('trust-template-showManagedBy'), { target: { value: 'off' } });
    api.updateTrustPageTemplate.mockRejectedValueOnce(new TypeError('network down'));
    await headerSave();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: "Couldn't save the Trust Center defaults" })));
    toast.mockClear();
    api.updateTrustPageTemplate.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'no', code: 'PARTNER_WIDE_REQUIRED' }), { status: 403 }));
    await headerSave();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringContaining('Only partner admins') })));
    // A failed save keeps the form (and its revision) in place.
    expect(api.getTrustPageTemplate).toHaveBeenCalledTimes(1);
  });

  it('read-only for a partner user without access to every organization', async () => {
    api.getTrustPageTemplate.mockResolvedValueOnce(loaded({ canManage: false }));
    render(<TrustTemplateSettings />);
    expect(await screen.findByTestId('trust-template-readonly')).toBeInTheDocument();
    expect(screen.getByTestId('trust-template-showManagedBy')).toBeDisabled();
    expect(screen.queryByTestId('trust-template-save')).toBeNull();
  });

  it('a failed load shows an error with retry', async () => {
    api.getTrustPageTemplate.mockRejectedValueOnce(new Error('boom'));
    render(<TrustTemplateSettings />);
    fireEvent.click(await screen.findByTestId('trust-template-retry'));
    await waitFor(() => expect(api.getTrustPageTemplate).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('trust-template-settings')).toBeInTheDocument();
  });
});
