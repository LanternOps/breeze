// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/trustAccessApi', () => ({ requestAccess: vi.fn() }));
import TrustDocumentsList from './TrustDocumentsList';
import { TrustLocaleContext } from './trustCopy';

const doc = (id: string, visibility: 'public' | 'gated') => ({ id, title: `Doc ${id}`, category: 'policy', contentType: 'application/pdf', byteSize: 2048, updatedAt: '2026-09-01T00:00:00.000Z', visibility });
const make = (over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) => ({
  payload: { documents: [doc('a', 'public'), doc('b', 'gated')], access: { ndaText: null }, ...over } as never,
  lastEvaluatedAt: null, preview: false, partnerSlug: 'nw', orgSlug: 'acme', ...props,
});

describe('TrustDocumentsList', () => {
  it('public rows link, gated rows say available on request', () => {
    render(<TrustDocumentsList {...make()} />);
    expect(screen.getByRole('link', { name: 'Doc a' })).toHaveAttribute('href', '/api/v1/trust/public/nw/acme/documents/a');
    expect(screen.getByTestId('trust-document-on-request-b')).toHaveTextContent('Available on request');
    expect(screen.queryByTestId('trust-document-on-request-a')).toBeNull();
  });

  it('shows one Request access button that opens the form inline', () => {
    render(<TrustDocumentsList {...make({ access: { ndaText: 'NDA body' } })} />);
    expect(screen.getAllByTestId('trust-request-access')).toHaveLength(1);
    expect(screen.queryByTestId('trust-access-submit')).toBeNull();
    fireEvent.click(screen.getByTestId('trust-request-access'));
    expect(screen.getByTestId('trust-access-submit')).toBeInTheDocument();
    expect(screen.getByTestId('trust-access-nda')).toHaveTextContent('NDA body');
  });

  it.each([
    ['access null', { access: null }, {}],
    ['no gated docs', { documents: [doc('a', 'public')] }, {}],
    ['preview', {}, { preview: true }],
    ['no partnerSlug', {}, { partnerSlug: null }],
  ])('no button when %s', (_n, over, props) => {
    render(<TrustDocumentsList {...make(over, props)} />);
    expect(screen.queryByTestId('trust-request-access')).toBeNull();
  });

  it('uses the page locale for strings and dates', () => {
    render(
      <TrustLocaleContext.Provider value="de-DE"><TrustDocumentsList {...make()} /></TrustLocaleContext.Provider>,
    );
    expect(screen.getByText('Dokumente')).toBeInTheDocument();
    expect(screen.getByTestId('trust-document-on-request-b')).toHaveTextContent('Auf Anfrage verfügbar');
    expect(screen.getByTestId('trust-document-a')).toHaveTextContent('2026');
    expect(screen.getByTestId('trust-document-a')).not.toHaveTextContent('9/1/2026');
  });
});
