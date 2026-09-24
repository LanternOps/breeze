import '@/lib/i18n';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The REAL runAction runs (#6644 review 6): the old passthrough mock never
// threw, so the stale-preview reset and 409/403 handling were never exercised.
const { fetchWithAuth, showToast, fetchPendingCounts, claims, canManagePartnerWide, viewer } = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  showToast: vi.fn(),
  fetchPendingCounts: vi.fn(),
  claims: { scope: 'partner' as 'partner' | 'organization', orgId: null as string | null, partnerId: 'p-1' },
  canManagePartnerWide: { value: true },
  viewer: { id: 'viewer-1' },
}));
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth,
  useAuthStore: (sel: (s: { user: { id: string; canManagePartnerWide: boolean } }) => unknown) => sel({ user: { id: viewer.id, canManagePartnerWide: canManagePartnerWide.value } }),
}));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => ({ status: 'resolved', claims }) }));
vi.mock('../../shared/Toast', () => ({ showToast }));
vi.mock('./conversionApi', async (importOriginal) => ({ ...(await importOriginal<typeof import('./conversionApi')>()), fetchPendingCounts }));

import ConversionPendingBanner from './ConversionPendingBanner';
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const partnerPreview = { data: { partnerId: 'p-1', previewHash: 'partner-h', policies: 9, rows: 40, convertible: 40, unconvertible: [] } };

beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); localStorage.clear(); viewer.id = 'viewer-1'; claims.scope = 'partner'; canManagePartnerWide.value = true; fetchPendingCounts.mockResolvedValue({ policies: 3, rows: 12, unconvertible: [], sweep: null }); });

describe('ConversionPendingBanner', () => {
  it('renders nothing when nothing is pending', async () => {
    fetchPendingCounts.mockResolvedValue({ policies: 0, rows: 0, unconvertible: [], sweep: null });
    const { container } = render(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} />);
    await waitFor(() => expect(fetchPendingCounts).toHaveBeenCalledWith('org-1'));
    expect(container).toBeEmptyDOMElement();
  });
  it('states the counts and Review hands off to the caller', async () => {
    const onReview = vi.fn();
    render(<ConversionPendingBanner orgId="org-1" onReview={onReview} />);
    expect(await screen.findByTestId('conversion-pending-banner')).toHaveTextContent(/12 legacy rules across 3 policies/);
    fireEvent.click(screen.getByTestId('conversion-pending-review'));
    expect(onReview).toHaveBeenCalled();
  });
  it('uses singular forms for one rule and one policy (sweep F5)', async () => {
    fetchPendingCounts.mockResolvedValue({ policies: 1, rows: 1 });
    render(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} />);
    const banner = await screen.findByTestId('conversion-pending-banner');
    expect(banner).toHaveTextContent('1 legacy rule across 1 policy');
    expect(banner).not.toHaveTextContent('1 policies');
    expect(banner).not.toHaveTextContent('1 legacy rules');
  });
  it('previews all partner policies even with one org selected, confirms the hash and reports the result', async () => {
    const onConverted = vi.fn();
    fetchWithAuth.mockResolvedValueOnce(json({ data: { partnerId: 'p-1', previewHash: 'partner-h', policies: 9, rows: 40, convertible: 39, unconvertible: [{ sourceTable: 'alert_templates', sourceId: 's1', name: 'Custom', policyId: null, policyName: null, reason: 'unconvertible:custom' }] } }))
      .mockResolvedValueOnce(json({ data: { policies: 9, converted: 39, unconvertible: 1 } }));
    render(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} onConverted={onConverted} />);
    fireEvent.click(await screen.findByTestId('conversion-convert-everything'));
    expect(await screen.findByTestId('conversion-convert-everything-confirm')).toHaveTextContent(/40 legacy rules/);
    expect(screen.getByTestId('conversion-convert-everything-confirm')).toHaveTextContent('Custom');
    fireEvent.click(screen.getByTestId('conversion-convert-everything-run'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/monitor-definitions/conversion/partner/convert-all', { method: 'POST', body: JSON.stringify({ previewHash: 'partner-h' }) }));
    await waitFor(() => expect(onConverted).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringMatching(/39.*9.*1/) }));
    expect(fetchPendingCounts).toHaveBeenCalledTimes(2);
  });
  it('drops a stale preview after a 409, shows readable text and needs a fresh preview to confirm again', async () => {
    const onConverted = vi.fn();
    fetchWithAuth.mockResolvedValueOnce(json(partnerPreview))
      .mockResolvedValueOnce(json({ error: 'preview_stale', message: 'Preview inputs changed' }, 409))
      .mockResolvedValueOnce(json({ data: { ...partnerPreview.data, previewHash: 'partner-h2' } }));
    render(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} onConverted={onConverted} />);
    fireEvent.click(await screen.findByTestId('conversion-convert-everything'));
    fireEvent.click(await screen.findByTestId('conversion-convert-everything-run'));
    await waitFor(() => expect(screen.queryByTestId('conversion-convert-everything-confirm')).toBeNull());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/preview again/i) }));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'preview_stale' }));
    expect(onConverted).not.toHaveBeenCalled();
    // The only way back to Convert is a fresh preview carrying the new hash.
    fireEvent.click(await screen.findByTestId('conversion-convert-everything'));
    await screen.findByTestId('conversion-convert-everything-confirm');
    expect(fetchWithAuth).toHaveBeenLastCalledWith('/monitor-definitions/conversion/partner/preview', { method: 'POST' });
  });
  it('surfaces MFA_REQUIRED (403) on convert-all and does not report success', async () => {
    const onConverted = vi.fn();
    fetchWithAuth.mockResolvedValueOnce(json(partnerPreview))
      .mockResolvedValueOnce(json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403));
    render(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} onConverted={onConverted} />);
    fireEvent.click(await screen.findByTestId('conversion-convert-everything'));
    fireEvent.click(await screen.findByTestId('conversion-convert-everything-run'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: expect.stringMatching(/multi-factor/i) })));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(onConverted).not.toHaveBeenCalled();
  });
  it('refetches counts when revision changes externally (e.g. an Undo elsewhere on the page)', async () => {
    const { rerender } = render(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} revision={0} />);
    await waitFor(() => expect(fetchPendingCounts).toHaveBeenCalledTimes(1));
    rerender(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} revision={1} />);
    await waitFor(() => expect(fetchPendingCounts).toHaveBeenCalledTimes(2));
  });
  it('hides Convert everything for an org-scoped caller and for a partner user without partner-wide rights', async () => {
    claims.scope = 'organization';
    const { unmount } = render(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} />);
    await screen.findByTestId('conversion-pending-banner');
    expect(screen.queryByTestId('conversion-convert-everything')).toBeNull();
    unmount();
    claims.scope = 'partner'; canManagePartnerWide.value = false;
    render(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} />);
    await screen.findByTestId('conversion-pending-banner');
    expect(screen.queryByTestId('conversion-convert-everything')).toBeNull();
  });
});

const retirementReport = (sweptAt = 's1') => ({ policies: 0, rows: 0,
  sweep: { sweptAt, converted: 2, retired: 1 },
  unconvertible: [{ sourceTable: 'config_policy_alert_rules', sourceId: 'r1', name: 'Custom',
    reason: 'unconvertible:custom_condition', policyId: 'p', policyName: 'Servers', retiredAt: sweptAt }],
});

describe('retirement report', () => {
  it('lists refused rows with policy, translated reason and open-alert guidance, then persists dismissal', async () => {
    fetchPendingCounts.mockResolvedValue(retirementReport());
    render(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} />);
    expect(await screen.findByText(/1 legacy rule could not be converted/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /review/i }));
    expect(screen.getByText('Custom')).toBeInTheDocument();
    expect(screen.getByText(/Servers/)).toBeInTheDocument();
    expect(screen.getByText('custom condition')).toBeInTheDocument();
    expect(screen.getByText('unconvertible:custom_condition')).toBeInTheDocument();
    expect(screen.getByText(/Their open alerts stay open/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByTestId('legacy-retirement-banner')).not.toBeInTheDocument();
    expect(localStorage.getItem('breeze.legacyAlertingRetirement.dismissed:viewer-1:org-1:s1')).toBe('1');
  });

  it('honors persisted dismissal, but reappears for a new sweep, viewer or scope', async () => {
    localStorage.setItem('breeze.legacyAlertingRetirement.dismissed:viewer-1:org-1:s1', '1');
    fetchPendingCounts.mockResolvedValue(retirementReport());
    const view = render(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} />);
    await waitFor(() => expect(fetchPendingCounts).toHaveBeenCalled());
    expect(screen.queryByTestId('legacy-retirement-banner')).not.toBeInTheDocument();
    viewer.id = 'viewer-2';
    view.rerender(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} />);
    expect(await screen.findByTestId('legacy-retirement-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    view.rerender(<ConversionPendingBanner orgId="org-2" onReview={vi.fn()} />);
    expect(await screen.findByTestId('legacy-retirement-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    fetchPendingCounts.mockResolvedValue(retirementReport('s2'));
    view.unmount();
    render(<ConversionPendingBanner orgId="org-2" onReview={vi.fn()} />);
    expect(await screen.findByTestId('legacy-retirement-banner')).toBeInTheDocument();
  });

  it.each([
    ['2026-09-20T10:00:00.000Z', '2026-09-21T10:00:00.000Z'],
    ['2026-09-21T10:00:00.000Z', '2026-09-20T10:00:00.000Z'],
  ])('uses the newer of sweep %s and retirement %s for dismissal', async (sweptAt, retiredAt) => {
    const report = retirementReport(sweptAt);
    report.unconvertible[0]!.retiredAt = retiredAt;
    const newer = '2026-09-21T10:00:00.000Z';
    localStorage.setItem('breeze.legacyAlertingRetirement.dismissed:viewer-1:org-1:2026-09-20T10:00:00.000Z', '1');
    fetchPendingCounts.mockResolvedValue(report);
    render(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} />);
    expect(await screen.findByTestId('legacy-retirement-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(localStorage.getItem(`breeze.legacyAlertingRetirement.dismissed:viewer-1:org-1:${newer}`)).toBe('1');
  });

  it('uses the retirement timestamp without a marker and preserves pending conversion actions', async () => {
    fetchPendingCounts.mockResolvedValue({ ...retirementReport(), policies: 1, rows: 2, sweep: null });
    render(<ConversionPendingBanner orgId={null} onReview={vi.fn()} />);
    expect(await screen.findByTestId('legacy-retirement-banner')).toBeInTheDocument();
    expect(screen.getByTestId('conversion-pending-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(localStorage.getItem('breeze.legacyAlertingRetirement.dismissed:viewer-1:p-1:s1')).toBe('1');
    expect(screen.getByTestId('conversion-pending-banner')).toBeInTheDocument();
  });

  it('handles unavailable storage and unknown reasons without losing the report', async () => {
    const report = retirementReport();
    report.unconvertible[0]!.reason = 'unconvertible:future_reason';
    fetchPendingCounts.mockResolvedValue(report);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('private'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('private'); });
    render(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    expect(screen.getByText(/conversion was refused; review the source/)).toBeInTheDocument();
    expect(screen.getByText('unconvertible:future_reason')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByTestId('legacy-retirement-banner')).not.toBeInTheDocument();
  });
});

it('clears prior reports on scope or viewer changes and ignores stale requests', async () => {
  let resolveOld!: (report: ReturnType<typeof retirementReport>) => void;
  fetchPendingCounts.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  const view = render(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} />);
  await waitFor(() => expect(fetchPendingCounts).toHaveBeenCalledWith('org-1'));
  const current = retirementReport('s2');
  current.unconvertible[0]!.name = 'Current';
  fetchPendingCounts.mockResolvedValueOnce(current);
  view.rerender(<ConversionPendingBanner orgId="org-2" onReview={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: /review/i }));
  expect(screen.getByText('Current')).toBeInTheDocument();
  await act(async () => resolveOld(retirementReport('s1')));
  expect(screen.queryByText('Custom')).not.toBeInTheDocument();
  expect(screen.getByText('Current')).toBeInTheDocument();
  let resolveNew!: (report: ReturnType<typeof retirementReport>) => void;
  fetchPendingCounts.mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
  viewer.id = 'viewer-2';
  view.rerender(<ConversionPendingBanner orgId="org-2" onReview={vi.fn()} />);
  expect(screen.queryByTestId('legacy-retirement-banner')).not.toBeInTheDocument();
  await waitFor(() => expect(fetchPendingCounts).toHaveBeenCalledTimes(3));
  await act(async () => resolveNew(current));
  expect(await screen.findByTestId('legacy-retirement-banner')).toBeInTheDocument();
});
