// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { portalApi, type PublicAgreementDetail } from '@/lib/api';
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { PublicAgreementView } from './PublicAgreementView';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TOKEN = 'tok/en 1';

const DETAIL: PublicAgreementDetail = {
  request: {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'sent',
    coverMessage: 'Please sign <b>today</b>.\nThanks!',
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
};

function mockGet(res: Awaited<ReturnType<typeof portalApi.getPublicAgreement>>) {
  return vi.spyOn(portalApi, 'getPublicAgreement').mockResolvedValue(res);
}
function mockLoaded(over: Partial<PublicAgreementDetail> = {}, reqOver: Partial<PublicAgreementDetail['request']> = {}) {
  return mockGet({ data: { data: { ...DETAIL, ...over, request: { ...DETAIL.request, ...reqOver } } } });
}
async function renderLoaded() {
  render(<PublicAgreementView token={TOKEN} />);
  await screen.findByTestId('document-root');
}
function fillAndSign(name = 'Jane Doe', email = 'Jane@Example.com') {
  fireEvent.change(screen.getByTestId('public-agreement-signer'), { target: { value: name } });
  fireEvent.change(screen.getByTestId('public-agreement-signer-email'), { target: { value: email } });
  fireEvent.click(screen.getByTestId('public-agreement-agree'));
  fireEvent.click(screen.getByTestId('public-agreement-accept'));
}

describe('PublicAgreementView', () => {
  it('fetches the agreement client-side on mount, showing a loading state first', async () => {
    const spy = mockLoaded();
    render(<PublicAgreementView token={TOKEN} />);
    expect(screen.getByTestId('public-agreement-loading')).toBeTruthy();
    await screen.findByTestId('document-root');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(TOKEN);
    expect(screen.queryByTestId('public-agreement-loading')).toBeNull();
  });

  it('renders no money anywhere and shows the body before the sign panel', async () => {
    mockLoaded();
    await renderLoaded();
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('$');
    expect(text.toLowerCase()).not.toContain('total');
    expect(text.toLowerCase()).not.toContain('price');
    expect(document.querySelector('[data-testid^="document-line"], [data-testid*="line-table"], [data-testid*="totals"]')).toBeNull();
    expect(screen.getByText('Agreement from Lantern IT for Acme Co')).toBeTruthy();
    const body = screen.getByTestId('agreement-html');
    const panel = screen.getByTestId('public-agreement-sign');
    expect(body.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Sign this agreement')).toBeTruthy();
    expect(screen.getByTestId('public-agreement-accept').textContent).toBe('Sign agreement');
  });

  it('omits "for ..." when there is no org', async () => {
    mockLoaded({ parties: { partnerName: 'Lantern IT', orgName: null } });
    await renderLoaded();
    expect(screen.getByText('Agreement from Lantern IT')).toBeTruthy();
  });

  it('renders the cover message as text, never HTML', async () => {
    mockLoaded();
    await renderLoaded();
    const cover = screen.getByTestId('public-agreement-cover-message');
    expect(cover.textContent).toContain('Please sign <b>today</b>.');
    expect(cover.querySelector('b')).toBeNull();
  });

  it('requires an email before signing, then posts (token, name, email) and shows the signed state', async () => {
    mockLoaded();
    const accept = vi.spyOn(portalApi, 'acceptPublicAgreement')
      .mockResolvedValue({ data: { data: { status: 'signed', signedAt: '2026-11-02T10:00:00.000Z' } } });
    await renderLoaded();
    fireEvent.change(screen.getByTestId('public-agreement-signer'), { target: { value: 'Jane Doe' } });
    fireEvent.click(screen.getByTestId('public-agreement-agree'));
    fireEvent.click(screen.getByTestId('public-agreement-accept'));
    expect(accept).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('public-agreement-signer-email'), { target: { value: 'Jane@Example.com' } });
    fireEvent.click(screen.getByTestId('public-agreement-accept'));
    await waitFor(() => expect(accept).toHaveBeenCalledWith(TOKEN, 'Jane Doe', 'jane@example.com'));
    const signed = await screen.findByTestId('public-agreement-signed');
    // Delivery is post-commit and best-effort: promise it, never claim it happened.
    expect(signed.textContent).toContain("Signed. We're emailing a copy to jane@example.com.");
    expect(signed.textContent).toContain("If it doesn't arrive, contact");
    expect(screen.queryByTestId('public-agreement-sign')).toBeNull();
  });

  it('names the agreement (not a proposal) in the consent and decline copy', async () => {
    mockLoaded();
    await renderLoaded();
    expect(screen.getByTestId('public-agreement-agree').closest('label')?.textContent).toContain('I have reviewed this agreement');
    fireEvent.click(screen.getByTestId('public-agreement-decline'));
    expect(screen.getByTestId('public-agreement-decline-panel').textContent).not.toContain('proposal');
  });

  it('shows an accept error in an alert and keeps the panel', async () => {
    mockLoaded();
    vi.spyOn(portalApi, 'acceptPublicAgreement').mockResolvedValue({ error: 'Already signed', code: 'ALREADY_SIGNED' });
    await renderLoaded();
    fillAndSign();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Already signed');
    expect(screen.getByTestId('public-agreement-sign')).toBeTruthy();
  });

  it('declines with a reason', async () => {
    mockLoaded();
    const decline = vi.spyOn(portalApi, 'declinePublicAgreement').mockResolvedValue({ data: { data: { status: 'declined' } } });
    await renderLoaded();
    fireEvent.click(screen.getByTestId('public-agreement-decline'));
    fireEvent.change(screen.getByTestId('public-agreement-decline-reason'), { target: { value: 'Not now' } });
    fireEvent.click(screen.getByTestId('public-agreement-decline-confirm'));
    await waitFor(() => expect(decline).toHaveBeenCalledWith(TOKEN, 'Not now'));
    const done = await screen.findByTestId('public-agreement-declined');
    expect(done.textContent).toContain('Thanks — Lantern IT has been notified.');
    expect(screen.queryByTestId('public-agreement-sign')).toBeNull();
  });

  it('is read-only when already signed on load', async () => {
    mockLoaded({}, { status: 'signed', signedAt: '2026-11-02T10:00:00.000Z' });
    await renderLoaded();
    expect(screen.queryByTestId('public-agreement-sign')).toBeNull();
    expect(screen.getByTestId('public-agreement-signed')).toBeTruthy();
  });

  it('is read-only when already declined on load', async () => {
    mockLoaded({}, { status: 'declined', declinedAt: '2026-11-02T10:00:00.000Z' });
    await renderLoaded();
    expect(screen.queryByTestId('public-agreement-sign')).toBeNull();
    expect(screen.getByTestId('public-agreement-declined')).toBeTruthy();
  });

  it('401 renders the generic invalid-link message, never "Session expired"', async () => {
    mockGet({ error: 'Session expired', statusCode: 401 } as never);
    render(<PublicAgreementView token={TOKEN} />);
    const err = await screen.findByTestId('public-agreement-error');
    expect(err.textContent).toContain('This agreement link is invalid or has expired.');
    expect(document.body.textContent).not.toContain('Session expired');
  });

  it.each([
    ['LINK_REVOKED', 'This agreement request was withdrawn', 'contact Lantern IT'],
    ['AGREEMENT_EXPIRED', 'This agreement request has expired', null],
    ['ORG_UNAVAILABLE', 'This link is no longer available', null],
  ])('410 %s renders a branding-only unavailable state', async (code, text, contact) => {
    mockGet({ error: 'gone', code, statusCode: 410, errorData: { branding: { partnerName: 'Lantern IT' } } } as never);
    render(<PublicAgreementView token={TOKEN} />);
    const el = await screen.findByTestId('public-agreement-unavailable');
    expect(el.textContent).toContain(text);
    if (contact) expect(el.textContent).toContain(contact);
    expect(screen.queryByTestId('public-agreement-sign')).toBeNull();
    expect(screen.queryByTestId('document-root')).toBeNull();
  });

  it('LINK_REVOKED without branding omits the contact line', async () => {
    mockGet({ error: 'gone', code: 'LINK_REVOKED', statusCode: 410 } as never);
    render(<PublicAgreementView token={TOKEN} />);
    const el = await screen.findByTestId('public-agreement-unavailable');
    expect(el.textContent).not.toContain('contact');
  });

  it('uploaded templates render the file viewer pointing at the token file route', async () => {
    mockLoaded({
      template: { name: 'Signed MSA', versionNumber: 1, sourceType: 'uploaded' },
      html: null,
      fileUrl: '/agreements/public/tok%2Fen%201/file',
    });
    await renderLoaded();
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('/api/v1/agreements/public/tok%2Fen%201/file');
    expect(screen.getByText('Download agreement')).toBeTruthy();
  });
});
