import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteDetail from './QuoteDetail';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { useOrgStore } from '../../../stores/orgStore';

// Provenance for an MSP-recorded acceptance. Without it the Detail page shows
// the same bare "Accepted" stamp whether the customer clicked Accept in the
// portal or a tech typed it in — and the only record of which is the audit log.
type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [{ resource: 'quotes', action: 'read' }] as Perm[] }));

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

const ORG_ID = 'aa0e43c8-1111-2222-3333-444455556666';

function converted(detailOverrides: Partial<QuoteDetailData> = {}): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: 'Q-1', partnerId: 'p-1', orgId: ORG_ID, siteId: null, status: 'converted',
      currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '0.00',
      billToName: 'Acme Inc.', introNotes: null, terms: null, termsAndConditions: null, sellerSnapshot: null,
      acceptedAt: '2026-09-21T12:00:00Z', declinedAt: null, convertedAt: '2026-09-21T12:00:00Z',
      convertedInvoiceId: 'inv-9', sentAt: '2026-09-20T09:00:00Z',
      viewedAt: null, createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
    },
    blocks: [],
    lines: [],
    ...detailOverrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'quotes', action: 'read' }];
  useOrgStore.setState({ organizations: [] });
});

describe('QuoteDetail — acceptance provenance', () => {
  it('names the tech and the evidence for an on-behalf acceptance', () => {
    render(<QuoteDetail detail={converted({ acceptance: {
      id: 'a1', signerName: 'Dana Buyer', signerEmail: null, signedAt: '2026-09-21T12:00:00Z',
      origin: 'on_behalf', method: 'purchase_order', reference: 'PO 4471',
      recordedBy: { id: 'tech-1', name: 'Sam Tech' },
    } })} />);
    const line = screen.getByTestId('quote-acceptance-provenance').textContent ?? '';
    expect(line).toContain('Dana Buyer');
    expect(line).toContain('Sam Tech');
    expect(line).toContain('PO 4471');
  });

  it('renders nothing extra for a customer acceptance', () => {
    render(<QuoteDetail detail={converted({ acceptance: {
      id: 'a1', signerName: 'Dana Buyer', signerEmail: null, signedAt: '2026-09-21T12:00:00Z',
      origin: 'customer', method: 'typed-signature', reference: null, recordedBy: null,
    } })} />);
    expect(screen.queryByTestId('quote-acceptance-provenance')).toBeNull();
  });

  // ON DELETE SET NULL: the recorder can be gone.
  it('survives a deleted recorder', () => {
    render(<QuoteDetail detail={converted({ acceptance: {
      id: 'a1', signerName: 'Dana Buyer', signerEmail: null, signedAt: '2026-09-21T12:00:00Z',
      origin: 'on_behalf', method: 'verbal', reference: 'call notes T-0231', recordedBy: null,
    } })} />);
    const line = screen.getByTestId('quote-acceptance-provenance');
    expect(line).toBeTruthy();
    // Never a blank where a person's name belongs.
    expect(line.textContent).toContain('a deleted user');
  });

  it('renders nothing when the quote carries no acceptance record at all', () => {
    render(<QuoteDetail detail={converted()} />);
    expect(screen.queryByTestId('quote-acceptance-provenance')).toBeNull();
  });

  // #6633 — the evidence file attached to an on-behalf acceptance.
  describe('acceptance evidence', () => {
    const EVIDENCE = { filename: 'po.pdf', contentType: 'application/pdf', sizeBytes: 100, uploadedAt: '2026-09-21T00:00:00Z' };

    it('renders the download control for an on-behalf acceptance with evidence', () => {
      render(<QuoteDetail detail={converted({ acceptance: {
        id: 'a1', signerName: 'Dana Buyer', signerEmail: null, signedAt: '2026-09-21T12:00:00Z',
        origin: 'on_behalf', method: 'purchase_order', reference: 'PO 4471',
        recordedBy: { id: 'tech-1', name: 'Sam Tech' }, evidence: EVIDENCE,
      } })} />);
      expect(screen.getByTestId('quote-acceptance-evidence-download')).toBeTruthy();
    });

    it('renders no evidence control for a customer acceptance', () => {
      render(<QuoteDetail detail={converted({ acceptance: {
        id: 'a1', signerName: 'Dana Buyer', signerEmail: null, signedAt: '2026-09-21T12:00:00Z',
        origin: 'customer', method: 'typed-signature', reference: null, recordedBy: null, evidence: null,
      } })} />);
      expect(screen.queryByTestId('quote-acceptance-evidence-download')).toBeNull();
      expect(screen.queryByTestId('quote-acceptance-evidence-attach')).toBeNull();
    });

    it('hides the attach control without quotes:accept', () => {
      render(<QuoteDetail detail={converted({ acceptance: {
        id: 'a1', signerName: 'Dana Buyer', signerEmail: null, signedAt: '2026-09-21T12:00:00Z',
        origin: 'on_behalf', method: 'verbal', reference: 'call notes', recordedBy: null, evidence: null,
      } })} />);
      expect(screen.queryByTestId('quote-acceptance-evidence-attach')).toBeNull();
    });

    it('shows the attach control with quotes:accept', () => {
      state.permissions = [{ resource: 'quotes', action: 'read' }, { resource: 'quotes', action: 'accept' }];
      render(<QuoteDetail detail={converted({ acceptance: {
        id: 'a1', signerName: 'Dana Buyer', signerEmail: null, signedAt: '2026-09-21T12:00:00Z',
        origin: 'on_behalf', method: 'verbal', reference: 'call notes', recordedBy: null, evidence: null,
      } })} />);
      expect(screen.getByTestId('quote-acceptance-evidence-attach')).toBeTruthy();
    });
  });
});
