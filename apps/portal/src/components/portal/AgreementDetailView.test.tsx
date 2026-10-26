// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { portalApi, type PortalAgreementDetail } from '@/lib/api';
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { AgreementDetailView } from './AgreementDetailView';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ID = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';

const DETAIL: PortalAgreementDetail = {
  request: {
    id: ID,
    status: 'sent',
    label: null,
    coverMessage: 'Please sign.\nThanks!',
    expiresAt: '2026-12-01T00:00:00.000Z',
    effectiveDate: '2026-11-01',
    signedAt: null,
    declinedAt: null,
  },
  template: { name: 'Master Services Agreement', versionNumber: 3, sourceType: 'authored' },
  html: '<p data-testid="agreement-html">The parties agree to the terms.</p>',
  fileUrl: null,
  parties: { partnerName: 'Lantern IT', orgName: 'Acme Co' },
  branding: { partnerName: 'Lantern IT', logoUrl: null, seller: null },
  canSign: true,
  signedAgreementId: null,
};

function detail(over: Partial<PortalAgreementDetail> = {}, reqOver: Partial<PortalAgreementDetail['request']> = {}): PortalAgreementDetail {
  return { ...DETAIL, ...over, request: { ...DETAIL.request, ...reqOver } };
}

function sign(name = 'Dana Buyer') {
  fireEvent.change(screen.getByTestId('agreement-signer'), { target: { value: name } });
  fireEvent.click(screen.getByTestId('agreement-agree'));
  fireEvent.click(screen.getByTestId('agreement-accept'));
}

describe('AgreementDetailView', () => {
  it('shows the sign panel to a named recipient with no email field', () => {
    render(<AgreementDetailView detail={detail()} />);
    expect(screen.getByTestId('agreement-sign')).toBeTruthy();
    expect(screen.queryByTestId('agreement-signer-email')).toBeNull();
    expect(screen.getByTestId('agreement-accept').textContent).toContain('Sign agreement');
    expect(screen.getByTestId('agreement-cover-message').textContent).toContain('Please sign.');
    expect(screen.getByTestId('agreement-back') ?? null).toBeTruthy();
  });

  it('accepts as the signed-in user, then shows signed with both download links', async () => {
    const accept = vi.spyOn(portalApi, 'acceptAgreement').mockResolvedValue({
      data: { data: { status: 'signed', signedAt: '2026-11-02T10:00:00.000Z', signedAgreementId: DOC } },
    });
    render(<AgreementDetailView detail={detail()} />);
    sign();
    await waitFor(() => expect(accept).toHaveBeenCalledWith(ID, 'Dana Buyer'));
    const signed = await screen.findByTestId('agreement-signed');
    // No email promise: delivery depends on the provider's mail setup.
    expect(signed.textContent).toContain('Signed. You can download your signed copy below.');
    expect(signed.textContent).not.toMatch(/email/i);
    expect(screen.queryByTestId('agreement-sign')).toBeNull();
    const certified = screen.getByTestId('agreement-download-certified');
    expect(certified.getAttribute('href')).toBe(`/api/v1/portal/signed-agreements/${DOC}/file?copy=certified`);
    expect(certified.textContent).toContain('Download signed copy');
    const original = screen.getByTestId('agreement-download-original');
    expect(original.getAttribute('href')).toBe(`/api/v1/portal/signed-agreements/${DOC}/file?copy=original`);
    expect(original.textContent).toContain('Original file');
  });

  it('shows a notice and no panel when the user is not a named recipient', () => {
    render(<AgreementDetailView detail={detail({ canSign: false })} />);
    expect(screen.queryByTestId('agreement-sign')).toBeNull();
    expect(screen.getByTestId('agreement-not-recipient').textContent).toContain(
      'This agreement was sent to another contact at your organization. Only a named recipient can sign it.',
    );
  });

  it('declines with a reason via the inline confirm', async () => {
    const decline = vi.spyOn(portalApi, 'declineAgreement').mockResolvedValue({ data: { data: { status: 'declined' } } });
    render(<AgreementDetailView detail={detail()} />);
    fireEvent.click(screen.getByTestId('agreement-decline'));
    fireEvent.change(screen.getByTestId('agreement-decline-reason'), { target: { value: 'Not now' } });
    fireEvent.click(screen.getByTestId('agreement-decline-confirm'));
    await waitFor(() => expect(decline).toHaveBeenCalledWith(ID, 'Not now'));
    const done = await screen.findByTestId('agreement-declined');
    expect(done.textContent).toContain('You declined this agreement — Lantern IT has been notified.');
    expect(screen.queryByTestId('agreement-sign')).toBeNull();
  });

  it('a 404 on accept says the agreement is unavailable and keeps the page', async () => {
    vi.spyOn(portalApi, 'acceptAgreement').mockResolvedValue({ error: 'Agreement not found', code: 'NOT_FOUND', statusCode: 404 });
    render(<AgreementDetailView detail={detail()} />);
    sign();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This agreement is no longer available.');
    expect(screen.getByTestId('document-root')).toBeTruthy();
    expect(screen.queryByTestId('agreement-not-found')).toBeNull();
  });

  it('a 409 shows the server message and keeps the panel when the request is still open', async () => {
    vi.spyOn(portalApi, 'acceptAgreement').mockResolvedValue({
      error: 'This agreement has already been signed.', code: 'AGREEMENT_ALREADY_SIGNED', statusCode: 409,
    });
    vi.spyOn(portalApi, 'getAgreement').mockResolvedValue({ data: { data: detail() } });
    render(<AgreementDetailView detail={detail()} />);
    sign();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This agreement has already been signed.');
    expect(screen.getByTestId('agreement-sign')).toBeTruthy();
  });

  it('a 409 after a lost response re-reads the request and shows it signed, with the downloads (never "try again")', async () => {
    vi.spyOn(portalApi, 'acceptAgreement').mockResolvedValue({
      error: 'This agreement request can no longer be signed', code: 'INVALID_STATE', statusCode: 409,
    });
    const refetch = vi.spyOn(portalApi, 'getAgreement').mockResolvedValue({
      data: { data: detail({ signedAgreementId: DOC }, { status: 'signed', signedAt: '2026-11-02T10:00:00.000Z' }) },
    });
    render(<AgreementDetailView detail={detail()} />);
    sign();
    expect(await screen.findByTestId('agreement-signed')).toBeTruthy();
    expect(refetch).toHaveBeenCalledWith(detail().request.id, { redirectOnUnauthorized: false });
    expect(screen.queryByTestId('agreement-sign')).toBeNull();
    expect(screen.getByTestId('agreement-download-certified').getAttribute('href')).toContain(`/signed-agreements/${DOC}/file?copy=certified`);
  });

  it('a loaded-signed agreement shows the downloads and no panel', () => {
    render(<AgreementDetailView detail={detail({ signedAgreementId: DOC }, { status: 'signed', signedAt: '2026-11-02T10:00:00.000Z' })} />);
    expect(screen.queryByTestId('agreement-sign')).toBeNull();
    expect(screen.getByTestId('agreement-signed')).toBeTruthy();
    expect(screen.getByTestId('agreement-download-certified').getAttribute('href')).toContain(`/signed-agreements/${DOC}/file?copy=certified`);
    expect(screen.getByTestId('agreement-download-original')).toBeTruthy();
  });

  it('a loaded-signed agreement without a document id shows no download links', () => {
    render(<AgreementDetailView detail={detail({}, { status: 'signed', signedAt: '2026-11-02T10:00:00.000Z' })} />);
    expect(screen.getByTestId('agreement-signed')).toBeTruthy();
    expect(screen.queryByTestId('agreement-download-certified')).toBeNull();
  });

  it('a loaded-declined agreement is read-only and never tells a colleague "you declined"', () => {
    render(<AgreementDetailView detail={detail({}, { status: 'declined', declinedAt: '2026-11-02T10:00:00.000Z' })} />);
    expect(screen.queryByTestId('agreement-sign')).toBeNull();
    const declined = screen.getByTestId('agreement-declined').textContent ?? '';
    expect(declined).toContain('This agreement was declined.');
    expect(declined).not.toContain('You declined');
  });

  it('embeds an uploaded template from the portal file route, not the public one', () => {
    render(<AgreementDetailView initial={detail({
      template: { name: 'Uploaded MSA', versionNumber: 1, sourceType: 'uploaded' },
      html: null,
      fileUrl: `/portal/agreements/${ID}/file`,
    })} />);
    const link = screen.getByTestId('agreement-download');
    expect(link.getAttribute('href')).toBe(`/api/v1/portal/agreements/${ID}/file`);
    expect(link.getAttribute('href')).not.toContain('/agreements/public/');
    expect(screen.queryByTestId('public-agreement-download')).toBeNull();
  });

  it('reads a 404 as not found, with a way back', () => {
    render(<AgreementDetailView detail={null} error="Agreement not found" statusCode={404} />);
    expect(screen.getByTestId('agreement-not-found')).toBeTruthy();
    expect(screen.queryByTestId('agreement-load-error')).toBeNull();
    expect(screen.getByTestId('agreement-back').getAttribute('href')).toContain('/agreements');
  });

  it('reads any other failure as a load error', () => {
    render(<AgreementDetailView detail={null} error="boom" statusCode={500} />);
    expect(screen.getByTestId('agreement-load-error')).toBeTruthy();
    expect(screen.queryByTestId('agreement-not-found')).toBeNull();
  });
});
