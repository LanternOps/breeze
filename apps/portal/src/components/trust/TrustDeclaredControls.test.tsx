// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { TrustPagePublicPayload } from '@breeze/shared';
import TrustDeclaredControls from './TrustDeclaredControls';
import { declaredCopy } from './declaredCopy';
import { copyParityProblems, TrustLocaleContext, type TrustSectionViewProps } from './trustCopy';

const DOC = '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6d';
const declared = (over: Partial<TrustPagePublicPayload['declaredControls'][number]> = {}): TrustPagePublicPayload['declaredControls'][number] => ({
  id: 'incident_response_plan', category: 'governance', source: 'declared', status: 'current',
  statement: 'We keep a written incident response plan.', declaredBy: 'Northwind IT',
  declaredAt: '2026-01-15T12:00:00.000Z', expiresAt: '2027-01-15T12:00:00.000Z', evidenceDocumentId: null,
  frameworkRefs: [{ framework: 'cis_v8', ref: '17.1' }], ...over,
});
const props = (declaredControls: TrustPagePublicPayload['declaredControls'], documents: unknown[] = []): TrustSectionViewProps => ({
  payload: { declaredControls, documents, locale: 'en' } as unknown as TrustPagePublicPayload,
  lastEvaluatedAt: null, preview: false, partnerSlug: 'nw', orgSlug: 'acme',
});

describe('TrustDeclaredControls', () => {
  it('renders nothing when there are no declared controls', () => {
    const { container } = render(<TrustDeclaredControls {...props([])} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a current declaration with the distinct Declared marker, attribution, statement and chips', () => {
    render(<TrustDeclaredControls {...props([declared()])} />);
    expect(screen.getByRole('heading', { name: 'Declared by the provider' })).toBeInTheDocument();
    const row = screen.getByTestId('trust-declared-incident_response_plan');
    expect(within(row).getByText('Incident response plan')).toBeInTheDocument();
    expect(within(row).getByTestId('trust-declared-incident_response_plan-marker')).toHaveTextContent('Declared');
    expect(within(row).getByText('Declared by Northwind IT on Jan 15, 2026')).toBeInTheDocument();
    expect(within(row).getByText('We keep a written incident response plan.')).toBeInTheDocument();
    expect(within(row).getByText('CIS v8 17.1 · IG1')).toBeInTheDocument();
    expect(within(row).queryByText(/expired/i)).toBeNull();
    // Never the telemetry pill vocabulary.
    expect(within(row).queryByText(/^Met$|Continuously verified/)).toBeNull();
  });

  it('an expired control gets the muted expiry copy and no current marker', () => {
    render(<TrustDeclaredControls {...props([declared({ status: 'expired', expiresAt: '2026-09-30T12:00:00.000Z' })])} />);
    const row = screen.getByTestId('trust-declared-incident_response_plan');
    expect(row).toHaveAttribute('data-status', 'expired');
    expect(within(row).getByText('Declaration expired on Sep 30, 2026')).toBeInTheDocument();
    expect(within(row).queryByTestId('trust-declared-incident_response_plan-marker')).toBeNull();
    expect(within(row).queryByText(/^Declared by/)).toBeNull();
  });

  it('renders the statement as plain text, never HTML', () => {
    const { container } = render(<TrustDeclaredControls {...props([declared({ statement: '<b>x</b>' })])} />);
    expect(screen.getByText('<b>x</b>')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
  });

  it('names the evidence document only when it is listed on the page', () => {
    const doc = { id: DOC, title: 'IR plan 2026', category: 'policy', contentType: 'application/pdf', byteSize: 1, updatedAt: '2026-01-01T00:00:00.000Z', visibility: 'public' };
    render(<TrustDeclaredControls {...props([declared({ evidenceDocumentId: DOC })], [doc])} />);
    expect(screen.getByText('Evidence: IR plan 2026')).toBeInTheDocument();
  });

  it('follows the page locale', () => {
    render(
      <TrustLocaleContext.Provider value="de-DE">
        <TrustDeclaredControls {...props([declared({ status: 'expired' })])} />
      </TrustLocaleContext.Provider>,
    );
    expect(screen.getByRole('heading', { name: 'Vom Anbieter erklärt' })).toBeInTheDocument();
    expect(screen.getByText(/^Erklärung abgelaufen am/)).toBeInTheDocument();
  });

  it('copy parity: every locale carries the English key set with no empty strings', () => {
    expect(copyParityProblems(declaredCopy as never)).toEqual([]);
  });
});
