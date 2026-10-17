// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    api.getTrustPageTemplate.mockResolvedValue(loaded());
    api.updateTrustPageTemplate.mockResolvedValue(okSave(EMPTY, 1));
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
    fireEvent.click(screen.getByTestId('trust-template-save'));
    await waitFor(() => expect(api.updateTrustPageTemplate).toHaveBeenCalled());
    expect(sentBody()).toEqual({ ...EMPTY, showManagedBy: false, expectedRevision: 0 });

    fireEvent.change(screen.getByTestId('trust-template-showHistory'), { target: { value: 'on' } });
    fireEvent.click(screen.getByTestId('trust-template-save'));
    await waitFor(() => expect(api.updateTrustPageTemplate).toHaveBeenCalledTimes(2));
    expect(sentBody()).toMatchObject({ showManagedBy: false, showHistory: true, expectedRevision: 1 });
  });

  it('choosing the Breeze default again clears the field (null)', async () => {
    api.getTrustPageTemplate.mockResolvedValueOnce(loaded({ template: { ...EMPTY, showManagedBy: false }, revision: 3 }));
    render(<TrustTemplateSettings />);
    const sel = await screen.findByTestId('trust-template-showManagedBy');
    expect(sel).toHaveValue('off');
    fireEvent.change(sel, { target: { value: 'inherit' } });
    fireEvent.click(screen.getByTestId('trust-template-save'));
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
    fireEvent.click(screen.getByTestId('trust-template-save'));
    await waitFor(() => expect(api.updateTrustPageTemplate).toHaveBeenCalled());
    expect(sentBody()).toMatchObject({ hiddenControlIds: ['edr_coverage'], frameworkView: ['essential_eight'] });
  });

  it('a blank intro is null; a written one is sent as is', async () => {
    render(<TrustTemplateSettings />);
    const intro = await screen.findByTestId('trust-template-intro');
    fireEvent.change(intro, { target: { value: '<p></p>' } });
    fireEvent.click(screen.getByTestId('trust-template-save'));
    await waitFor(() => expect(api.updateTrustPageTemplate).toHaveBeenCalledTimes(1));
    expect(sentBody().introHtml).toBeNull();
    fireEvent.change(intro, { target: { value: '<p>We watch every device.</p>' } });
    fireEvent.click(screen.getByTestId('trust-template-save'));
    await waitFor(() => expect(api.updateTrustPageTemplate).toHaveBeenCalledTimes(2));
    expect(sentBody().introHtml).toBe('<p>We watch every device.</p>');
  });

  it('a stale revision reloads the template', async () => {
    render(<TrustTemplateSettings />);
    await screen.findByTestId('trust-template-save');
    api.updateTrustPageTemplate.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'stale', code: 'REVISION_MISMATCH' }), { status: 409 }));
    api.getTrustPageTemplate.mockResolvedValueOnce(loaded({ template: { ...EMPTY, showHistory: true }, revision: 7 }));
    fireEvent.click(screen.getByTestId('trust-template-save'));
    await waitFor(() => expect(api.getTrustPageTemplate).toHaveBeenCalledTimes(2));
    // The other admin's values replace the stale draft, and the next save carries their revision.
    expect(await screen.findByTestId('trust-template-showHistory')).toHaveValue('on');
    fireEvent.click(screen.getByTestId('trust-template-save'));
    await waitFor(() => expect(sentBody()).toMatchObject({ showHistory: true, expectedRevision: 7 }));
  });

  it('a failed save is toasted: a network error with the fallback, a partner-wide 403 with the read-only reason', async () => {
    render(<TrustTemplateSettings />);
    await screen.findByTestId('trust-template-save');
    api.updateTrustPageTemplate.mockRejectedValueOnce(new TypeError('network down'));
    fireEvent.click(screen.getByTestId('trust-template-save'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: "Couldn't save the Trust Center defaults" })));
    toast.mockClear();
    api.updateTrustPageTemplate.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'no', code: 'PARTNER_WIDE_REQUIRED' }), { status: 403 }));
    fireEvent.click(screen.getByTestId('trust-template-save'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringContaining('Only partner admins') })));
    // A failed save keeps the form (and its revision) in place.
    expect(api.getTrustPageTemplate).toHaveBeenCalledTimes(1);
  });

  it('read-only for a partner user without access to every organization', async () => {
    api.getTrustPageTemplate.mockResolvedValueOnce(loaded({ canManage: false }));
    render(<TrustTemplateSettings />);
    expect(await screen.findByTestId('trust-template-readonly')).toBeInTheDocument();
    expect(screen.getByTestId('trust-template-showManagedBy')).toBeDisabled();
    expect(screen.getByTestId('trust-template-save')).toBeDisabled();
  });

  it('a failed load shows an error with retry', async () => {
    api.getTrustPageTemplate.mockRejectedValueOnce(new Error('boom'));
    render(<TrustTemplateSettings />);
    fireEvent.click(await screen.findByTestId('trust-template-retry'));
    await waitFor(() => expect(api.getTrustPageTemplate).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('trust-template-save')).toBeInTheDocument();
  });
});
