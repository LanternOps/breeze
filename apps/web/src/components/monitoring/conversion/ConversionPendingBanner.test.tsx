import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The REAL runAction runs (#6644 review 6): the old passthrough mock never
// threw, so the stale-preview reset and 409/403 handling were never exercised.
const { fetchWithAuth, showToast, fetchPendingCounts, claims, canManagePartnerWide } = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  showToast: vi.fn(),
  fetchPendingCounts: vi.fn(),
  claims: { scope: 'partner' as 'partner' | 'organization', orgId: null as string | null, partnerId: 'p-1' },
  canManagePartnerWide: { value: true },
}));
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth,
  useAuthStore: (sel: (s: { user: { canManagePartnerWide: boolean } }) => unknown) => sel({ user: { canManagePartnerWide: canManagePartnerWide.value } }),
}));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => ({ status: 'resolved', claims }) }));
vi.mock('../../shared/Toast', () => ({ showToast }));
vi.mock('./conversionApi', async (importOriginal) => ({ ...(await importOriginal<typeof import('./conversionApi')>()), fetchPendingCounts }));

import ConversionPendingBanner from './ConversionPendingBanner';
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const partnerPreview = { data: { partnerId: 'p-1', previewHash: 'partner-h', policies: 9, rows: 40, convertible: 40, unconvertible: [] } };

beforeEach(() => { vi.clearAllMocks(); claims.scope = 'partner'; canManagePartnerWide.value = true; fetchPendingCounts.mockResolvedValue({ policies: 3, rows: 12 }); });

describe('ConversionPendingBanner', () => {
  it('renders nothing when nothing is pending', async () => {
    fetchPendingCounts.mockResolvedValue({ policies: 0, rows: 0 });
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
