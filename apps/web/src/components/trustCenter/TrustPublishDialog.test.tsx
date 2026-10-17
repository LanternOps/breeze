// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@/lib/i18n';
const api = vi.hoisted(() => ({ publishTrustPage: vi.fn() }));
vi.mock('@/lib/api/trustPage', () => api);
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/shared/Toast', () => ({ showToast: toast }));
import TrustPublishDialog from './TrustPublishDialog';

const page = (over: Record<string, unknown> = {}) => ({ id: 'pg', orgId: 'o1', isPartnerHome: false, publishedAt: null, publicationRevision: 5, searchIndexable: false, showPercentages: false, showDeviceCount: false, showManagedBy: true, securityContactEmail: null, websiteUrl: null, introHtml: null, hiddenControlIds: [], publicationAuthorizedBy: null, publicationAuthorizedAt: null, lastEvaluatedAt: null, ...over }) as never;
const orgFetch = vi.fn() as never;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('TrustPublishDialog', () => {
  beforeEach(() => vi.clearAllMocks());
  it('a recorded attestation is shown and reused; Change reopens the fields', async () => {
    api.publishTrustPage.mockResolvedValue(json({ data: { page: page(), snapshotId: 's' } }));
    const onPublished = vi.fn();
    render(<TrustPublishDialog open onClose={vi.fn()} orgId="o1" orgFetch={orgFetch} searchIndexable={false} page={page({ publicationAuthorizedBy: 'Jane Doe, COO', publicationAuthorizedAt: '2026-09-01T00:00:00Z' })} onPublished={onPublished} onStale={vi.fn(async () => undefined)} />);
    expect(screen.getByText(/Jane Doe, COO/)).toBeInTheDocument();
    expect(screen.queryByTestId('trust-publish-authorized-by')).toBeNull();
    fireEvent.click(screen.getByTestId('trust-publish-confirm'));
    await waitFor(() => expect(api.publishTrustPage).toHaveBeenCalledWith(orgFetch, 'o1', { expectedRevision: 5 }));
    await waitFor(() => expect(onPublished).toHaveBeenCalled());
  });
  it('Change demands a new checkbox + name and sends them', async () => {
    api.publishTrustPage.mockResolvedValue(json({ data: { page: page(), snapshotId: 's' } }));
    render(<TrustPublishDialog open onClose={vi.fn()} orgId="o1" orgFetch={orgFetch} searchIndexable={false} page={page({ publicationAuthorizedBy: 'Jane Doe, COO', publicationAuthorizedAt: '2026-09-01T00:00:00Z' })} onPublished={vi.fn()} onStale={vi.fn(async () => undefined)} />);
    fireEvent.click(screen.getByTestId('trust-publish-change'));
    expect(screen.getByTestId('trust-publish-confirm')).toBeDisabled();
    fireEvent.click(screen.getByTestId('trust-publish-authorized-checkbox'));
    fireEvent.change(screen.getByTestId('trust-publish-authorized-by'), { target: { value: 'Sam Lee, CEO' } });
    fireEvent.click(screen.getByTestId('trust-publish-confirm'));
    await waitFor(() => expect(api.publishTrustPage).toHaveBeenCalledWith(orgFetch, 'o1', { expectedRevision: 5, authorization: { authorizedBy: 'Sam Lee, CEO' } }));
  });
  it('W2: the indexing notice follows the EFFECTIVE value, even when the page column is null (inherited)', () => {
    render(<TrustPublishDialog open onClose={vi.fn()} orgId="o1" orgFetch={orgFetch} searchIndexable page={page({ isPartnerHome: true, searchIndexable: null })} onPublished={vi.fn()} onStale={vi.fn(async () => undefined)} />);
    expect(screen.getByText(/search engines may index it/)).toBeInTheDocument();
  });
  it('a partner-home page has no attestation fields and sends no authorization', async () => {
    api.publishTrustPage.mockResolvedValue(json({ data: { page: page(), snapshotId: 's' } }));
    render(<TrustPublishDialog open onClose={vi.fn()} orgId="o1" orgFetch={orgFetch} searchIndexable={false} page={page({ isPartnerHome: true })} onPublished={vi.fn()} onStale={vi.fn(async () => undefined)} />);
    expect(screen.queryByTestId('trust-publish-authorized-checkbox')).toBeNull();
    fireEvent.click(screen.getByTestId('trust-publish-confirm'));
    await waitFor(() => expect(api.publishTrustPage).toHaveBeenCalledWith(orgFetch, 'o1', { expectedRevision: 5 }));
  });
  it.each([
    ['AUTHORIZATION_REQUIRED', 422, /who authorized/],
    ['MFA_REQUIRED', 403, /multi-factor/i],
    ['TRUST_PROBATION', 403, /opens once your account is trusted/],
    ['TRUST_RESTRICTED', 403, /opens once your account is trusted/],
    ['SLUG_INVALID', 422, /address is not valid/],
    ['PARTNER_HOME_INTERNAL_ONLY', 422, /own \(internal\) organization/],
    ['INTRO_TOO_LONG', 422, /too long/],
  ])('maps %s to friendly copy', async (code, status, re) => {
    api.publishTrustPage.mockResolvedValue(json({ error: 'The page address is not valid', code }, status));
    render(<TrustPublishDialog open onClose={vi.fn()} orgId="o1" orgFetch={orgFetch} searchIndexable={false} page={page({ isPartnerHome: true })} onPublished={vi.fn()} onStale={vi.fn(async () => undefined)} />);
    fireEvent.click(screen.getByTestId('trust-publish-confirm'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(re) })));
  });
  it('REVISION_MISMATCH refreshes via onStale and closes the dialog', async () => {
    api.publishTrustPage.mockResolvedValue(json({ error: 'stale', code: 'REVISION_MISMATCH' }, 409));
    const onStale = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(<TrustPublishDialog open onClose={onClose} orgId="o1" orgFetch={orgFetch} searchIndexable={false} page={page({ isPartnerHome: true })} onPublished={vi.fn()} onStale={onStale} />);
    fireEvent.click(screen.getByTestId('trust-publish-confirm'));
    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/changed since you loaded it/) }));
  });
});
