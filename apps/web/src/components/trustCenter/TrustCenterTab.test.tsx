// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@/lib/i18n';
const api = vi.hoisted(() => ({ getTrustPage: vi.fn(), getTrustControls: vi.fn(), publishTrustPage: vi.fn(), unpublishTrustPage: vi.fn(), updateTrustPage: vi.fn(), updateTrustDocuments: vi.fn(), setPartnerHome: vi.fn(), createPreviewToken: vi.fn(), trustPublicUrl: (p: string) => `https://breeze.test${p}` }));
vi.mock('@/lib/api/trustPage', () => api);
const perms = vi.hoisted(() => ({ canWrite: true }));
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ permissions: [], can: () => perms.canWrite }) }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => ({ status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p1' } }) }));
vi.mock('@/lib/api/orgDocuments', () => ({ listOrgDocuments: vi.fn(async () => []) }));
import TrustCenterTab from './TrustCenterTab';

const state = (over: Record<string, unknown> = {}) => ({
  page: { id: 'pg', orgId: 'o1', isPartnerHome: false, publishedAt: null, publicationRevision: 3, searchIndexable: false, showPercentages: false, showDeviceCount: false, showManagedBy: true, securityContactEmail: null, websiteUrl: null, introHtml: null, hiddenControlIds: [], publicationAuthorizedBy: null, publicationAuthorizedAt: null, lastEvaluatedAt: null, ...over },
  publicPath: '/portal/trust/nw/acme', badgePath: '/api/v1/trust/public/nw/acme/badge.svg',
  slugs: { partnerSlug: 'nw', orgSlug: 'acme', valid: true, problems: [] }, canPublish: { allowed: true, reason: null },
});
const controls = { assessments: [], catalog: [], evaluatedAt: new Date().toISOString(), deviceCount: 0 };
const orgFetch = vi.fn() as never;

describe('TrustCenterTab', () => {
  beforeEach(() => { vi.clearAllMocks(); perms.canWrite = true; api.getTrustControls.mockResolvedValue(controls); });
  it('shows Unpublished state and the public URL; first publish of a customer page demands the attestation', async () => {
    api.getTrustPage.mockResolvedValue(state());
    api.publishTrustPage.mockResolvedValue(new Response(JSON.stringify({ data: { page: { ...state().page, publishedAt: new Date().toISOString(), publicationRevision: 4 }, snapshotId: 's' } }), { status: 200 }));
    render(<TrustCenterTab orgId="o1" orgFetch={orgFetch} />);
    expect(await screen.findByText(/Unpublished/)).toBeInTheDocument();
    expect(screen.getByText('https://breeze.test/portal/trust/nw/acme')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('trust-publish'));
    const confirm = screen.getByTestId('trust-publish-confirm');
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByTestId('trust-publish-authorized-checkbox'));
    fireEvent.change(screen.getByTestId('trust-publish-authorized-by'), { target: { value: 'Jane Doe, COO' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(api.publishTrustPage).toHaveBeenCalledWith(orgFetch, 'o1', { expectedRevision: 3, authorization: { authorizedBy: 'Jane Doe, COO' } }));
    expect(await screen.findByText(/Published/)).toBeInTheDocument();
  });
  it('disables Publish with an explanation when a slug is invalid or the partner is on probation', async () => {
    api.getTrustPage.mockResolvedValue({ ...state(), slugs: { partnerSlug: 'nw', orgSlug: 'Acme Dental', valid: false, problems: ['org_slug'] } });
    render(<TrustCenterTab orgId="o1" orgFetch={orgFetch} />);
    expect(await screen.findByTestId('trust-publish')).toBeDisabled();
    expect(screen.getByText(/organization slug/i)).toBeInTheDocument();
  });
  it('disables Publish and shows the API reason when the trust gate denies', async () => {
    api.getTrustPage.mockResolvedValue({ ...state(), canPublish: { allowed: false, reason: 'Account is on probation' } });
    render(<TrustCenterTab orgId="o1" orgFetch={orgFetch} />);
    expect(await screen.findByTestId('trust-publish')).toBeDisabled();
    expect(screen.getByText(/Account is on probation/)).toBeInTheDocument();
  });
  it('disables every mutation button without organizations:write', async () => {
    perms.canWrite = false;
    api.getTrustPage.mockResolvedValue(state({ publishedAt: '2026-10-01T00:00:00Z' }));
    render(<TrustCenterTab orgId="o1" orgFetch={orgFetch} />);
    expect(await screen.findByTestId('trust-publish')).toBeDisabled();
    expect(screen.getByTestId('trust-unpublish')).toBeDisabled();
    expect(screen.getByTestId('trust-preview')).toBeDisabled();
    expect(screen.getByTestId('trust-partner-home-switch')).toBeDisabled();
  });
  it('partner-home page skips the attestation; unpublish asks for confirmation', async () => {
    api.getTrustPage.mockResolvedValue(state({ isPartnerHome: true, publishedAt: '2026-10-01T00:00:00Z' }));
    api.unpublishTrustPage.mockResolvedValue(new Response(JSON.stringify({ data: { page: state().page } }), { status: 200 }));
    render(<TrustCenterTab orgId="o1" orgFetch={orgFetch} />);
    fireEvent.click(await screen.findByTestId('trust-unpublish'));
    fireEvent.click(screen.getByTestId('trust-unpublish-confirm'));
    await waitFor(() => expect(api.unpublishTrustPage).toHaveBeenCalledWith(orgFetch, 'o1'));
  });
  it('hides the partner-home switch when the API answers PARTNER_WIDE_REQUIRED', async () => {
    api.getTrustPage.mockResolvedValue(state());
    api.setPartnerHome.mockResolvedValue(new Response(JSON.stringify({ error: 'no', code: 'PARTNER_WIDE_REQUIRED' }), { status: 403 }));
    render(<TrustCenterTab orgId="o1" orgFetch={orgFetch} />);
    fireEvent.click(await screen.findByTestId('trust-partner-home-switch'));
    await waitFor(() => expect(api.setPartnerHome).toHaveBeenCalledWith(orgFetch, 'o1', true));
    await waitFor(() => expect(screen.queryByTestId('trust-partner-home-switch')).toBeNull());
  });
  it('after a stale-revision 409 the retry sends the refreshed revision', async () => {
    api.getTrustPage.mockResolvedValueOnce(state({ isPartnerHome: true })).mockResolvedValue(state({ isPartnerHome: true, publicationRevision: 4 }));
    api.publishTrustPage
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'stale', code: 'REVISION_MISMATCH' }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { page: state({ publishedAt: new Date().toISOString() }).page, snapshotId: 's' } }), { status: 200 }));
    render(<TrustCenterTab orgId="o1" orgFetch={orgFetch} />);
    fireEvent.click(await screen.findByTestId('trust-publish'));
    fireEvent.click(screen.getByTestId('trust-publish-confirm'));
    await waitFor(() => expect(api.publishTrustPage).toHaveBeenCalledWith(orgFetch, 'o1', { expectedRevision: 3 }));
    await waitFor(() => expect(screen.queryByTestId('trust-publish-confirm')).toBeNull());
    fireEvent.click(screen.getByTestId('trust-publish'));
    fireEvent.click(screen.getByTestId('trust-publish-confirm'));
    await waitFor(() => expect(api.publishTrustPage).toHaveBeenLastCalledWith(orgFetch, 'o1', { expectedRevision: 4 }));
  });
  it('a read-only user clicking the buttons triggers no request', async () => {
    perms.canWrite = false;
    api.getTrustPage.mockResolvedValue(state({ publishedAt: '2026-10-01T00:00:00Z' }));
    render(<TrustCenterTab orgId="o1" orgFetch={orgFetch} />);
    for (const id of ['trust-publish', 'trust-unpublish', 'trust-preview', 'trust-partner-home-switch']) fireEvent.click(await screen.findByTestId(id));
    expect(screen.queryByTestId('trust-publish-dialog')).toBeNull();
    expect(screen.queryByTestId('trust-unpublish-confirm')).toBeNull();
    for (const k of ['publishTrustPage', 'unpublishTrustPage', 'createPreviewToken', 'setPartnerHome']) expect(api[k as 'publishTrustPage']).not.toHaveBeenCalled();
  });
});
