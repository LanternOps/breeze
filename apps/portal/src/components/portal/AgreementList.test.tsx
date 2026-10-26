// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PortalAgreementSummary, PortalSignedAgreement } from '@/lib/api';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { AgreementList } from './AgreementList';

afterEach(cleanup);

const pending = (over: Partial<PortalAgreementSummary> = {}): PortalAgreementSummary => ({
  id: 'p1', name: 'Master Services Agreement', templateName: 'MSA', status: 'sent',
  sentAt: '2026-11-01T00:00:00.000Z', expiresAt: '2026-12-01T00:00:00.000Z', canSign: true, ...over,
});
const signed = (over: Partial<PortalSignedAgreement> = {}): PortalSignedAgreement => ({
  id: 's1', name: 'Signed MSA', templateName: 'MSA', versionNumber: 2, sourceKind: 'request', quoteNumber: null,
  mime: 'application/pdf', byteSize: 1000, signerName: 'Dana Buyer', signedAt: '2026-11-05T12:00:00.000Z',
  acceptanceOrigin: 'customer', createdAt: '2026-11-05T12:00:01.000Z', ...over,
});

describe('AgreementList', () => {
  it('lists a signable pending agreement with a Review & sign link', () => {
    render(<AgreementList pending={[pending()]} signed={[]} />);
    const row = screen.getByTestId('agreements-pending-row-p1');
    expect(row.textContent).toContain('Master Services Agreement');
    expect(row.textContent).toContain('Expires');
    const link = row.querySelector('a') as HTMLAnchorElement;
    expect(link.textContent).toBe('Review & sign');
    expect(link.getAttribute('href')).toContain('/agreements/p1');
    expect(row.textContent).not.toContain('Sent to another contact');
  });

  it('shows View and a muted note for an agreement sent to another contact', () => {
    render(<AgreementList pending={[pending({ canSign: false })]} signed={[]} />);
    const row = screen.getByTestId('agreements-pending-row-p1');
    expect((row.querySelector('a') as HTMLAnchorElement).textContent).toBe('View');
    expect(row.textContent).toContain('Sent to another contact');
  });

  it('describes signed agreements by source and links both copies', () => {
    render(
      <AgreementList
        pending={[]}
        signed={[
          signed(),
          signed({ id: 's2', sourceKind: 'quote', quoteNumber: 'Q-1042' }),
          signed({ id: 's3', sourceKind: 'quote', quoteNumber: null, signedAt: null, createdAt: '2026-10-01T00:00:00.000Z' }),
        ]}
      />,
    );
    expect(screen.getByTestId('agreements-signed-row-s1').textContent).toContain('Signed agreement');
    expect(screen.getByTestId('agreements-signed-row-s2').textContent).toContain('Accepted with proposal Q-1042');
    expect(screen.getByTestId('agreements-signed-row-s3').textContent).toContain('Accepted with a proposal');
    const certified = screen.getByTestId('agreements-signed-download-s1');
    expect(certified.textContent).toBe('Signed copy');
    expect(certified.getAttribute('href')).toBe('/api/v1/portal/signed-agreements/s1/file?copy=certified');
    const original = screen.getByTestId('agreements-signed-original-s1');
    expect(original.textContent).toBe('Original');
    expect(original.getAttribute('href')).toBe('/api/v1/portal/signed-agreements/s1/file?copy=original');
  });

  it('shows an empty state per section', () => {
    render(<AgreementList pending={[]} signed={[]} />);
    expect(screen.getByTestId('agreements-pending-empty')).toBeTruthy();
    expect(screen.getByTestId('agreements-signed-empty')).toBeTruthy();
    expect(screen.queryByTestId('agreements-pending-list')).toBeNull();
    expect(screen.queryByTestId('agreements-signed-list')).toBeNull();
  });

  it('shows the error banner instead of the lists', () => {
    render(<AgreementList pending={[]} signed={[]} error="Could not load" />);
    expect(screen.getByTestId('agreements-load-error').textContent).toContain('Could not load');
    expect(screen.queryByTestId('agreements-pending-empty')).toBeNull();
  });
});
