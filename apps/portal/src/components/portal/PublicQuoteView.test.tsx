// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { portalApi, type PublicQuoteDetail } from '@/lib/api';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { PublicQuoteView } from './PublicQuoteView';

afterEach(() => {
  cleanup();
  window.location.hash = '';
  vi.restoreAllMocks();
});

const DETAIL: PublicQuoteDetail = {
  quote: {
    id: '11111111-1111-4111-8111-111111111111',
    quoteNumber: 'Q-2026-0042',
    title: 'Managed Services',
    status: 'viewed',
    currencyCode: 'USD',
    issueDate: '2026-07-01',
    expiryDate: '2026-08-01',
    subtotal: '432.00',
    taxRate: '0.08000',
    taxTotal: '32.00',
    total: '432.00',
    oneTimeTotal: '300.00',
    monthlyRecurringTotal: '75.00',
    annualRecurringTotal: '25.00',
    depositType: 'percent',
    depositAmount: '97.20',
    dueOnAcceptanceTotal: '324.00',
    depositDueTotal: '97.20',
    categoryBreakdown: [
      { category: 'hardware', oneTimeTotal: '300.00', monthlyTotal: '0.00', annualTotal: '0.00' },
      { category: 'service', oneTimeTotal: '0.00', monthlyTotal: '75.00', annualTotal: '25.00' },
    ],
    billToName: 'Acme Co',
    introNotes: 'A customer-ready proposal.',
    terms: 'Net 30',
    sellerSnapshot: {
      name: 'Lantern IT',
      address: {
        line1: '1 Main Street',
        line2: null,
        city: 'Denver',
        region: 'CO',
        postalCode: '80202',
        country: 'US',
      },
      phone: '555-0100',
      email: 'sales@example.test',
      website: 'https://example.test',
    },
    coverPage: null,
    termsAndConditions: 'Customer-facing terms and conditions.',
  },
  blocks: [],
  lines: [
    {
      id: 'monthly-line', blockId: null, name: 'Monthly service', description: '',
      quantity: '1.00', unitPrice: '75.00', lineTotal: '75.00', recurrence: 'monthly',
      customerVisible: true, sortOrder: 0,
    },
    {
      id: 'annual-line', blockId: null, name: 'Annual service', description: '',
      quantity: '1.00', unitPrice: '25.00', lineTotal: '25.00', recurrence: 'annual',
      customerVisible: true, sortOrder: 1,
    },
  ],
  branding: {
    partnerName: 'Lantern IT',
    logoUrl: null,
    primaryColor: '#123456',
  },
};

describe('PublicQuoteView exact public quote contract', () => {
  it('renders seller, recurring totals, deposit, categories, dates, and terms', () => {
    render(<PublicQuoteView token="public-token" initial={DETAIL} />);

    const document = screen.getByTestId('public-quote');
    expect(document.textContent).toContain('Lantern IT');
    expect(document.textContent).toContain('sales@example.test');
    expect(document.textContent).toContain('Monthly recurring');
    expect(document.textContent).toContain('$75.00/mo');
    expect(document.textContent).toContain('Annual recurring');
    expect(document.textContent).toContain('$25.00/yr');
    expect(screen.getByTestId('public-quote-deposit-due').textContent).toContain('$97.20');
    expect(screen.getByTestId('public-quote-category-breakdown').textContent).toContain('hardware');
    expect(document.textContent).toContain('Issued');
    expect(document.textContent).toContain('Valid until');
    expect(document.textContent).toContain('Net 30');
    expect(screen.getByTestId('public-quote-terms-conditions').textContent)
      .toContain('Customer-facing terms and conditions.');
  });

  it('collapses Terms & Conditions by default and summarises sections + read time', () => {
    const withSections = { ...DETAIL, quote: { ...DETAIL.quote, termsAndConditions: '1. Payment\nNet 30.\n2. Term\nOne year.' } };
    render(<PublicQuoteView token="public-token" initial={withSections} />);
    const el = screen.getByTestId('public-quote-terms-conditions') as HTMLDetailsElement;
    expect(el.tagName).toBe('DETAILS');
    expect(el.open).toBe(false);
    const summary = el.querySelector('summary')!.textContent;
    expect(summary).toContain('Terms & Conditions');
    expect(summary).toContain('2 sections · ~1 min read');
  });

  it('opens the T&C when location.hash is #terms', async () => {
    window.location.hash = '#terms';
    render(<PublicQuoteView token="public-token" initial={DETAIL} />);
    await waitFor(() => expect((screen.getByTestId('public-quote-terms-conditions') as HTMLDetailsElement).open).toBe(true));
    window.location.hash = '';
  });

  it('clicking the checkbox T&C link reopens a manually collapsed block', () => {
    render(<PublicQuoteView token="public-token" initial={DETAIL} />);
    const el = screen.getByTestId('public-quote-terms-conditions') as HTMLDetailsElement;
    const link = screen.getByTestId('public-quote-agree').closest('label')!.querySelector('a')!;
    fireEvent.click(link);
    expect(el.open).toBe(true);
    el.open = false;
    fireEvent(el, new Event('toggle'));
    expect(el.open).toBe(false);
    fireEvent.click(link);
    expect(el.open).toBe(true);
  });

  it('expands the T&C for print and restores after', () => {
    render(<PublicQuoteView token="public-token" initial={DETAIL} />);
    const el = screen.getByTestId('public-quote-terms-conditions') as HTMLDetailsElement;
    fireEvent(window, new Event('beforeprint'));
    expect(el.open).toBe(true);
    fireEvent(window, new Event('afterprint'));
    expect(el.open).toBe(false);
  });

  it('renders the sign panel after the totals and before the T&C', () => {
    render(<PublicQuoteView token="public-token" initial={DETAIL} />);
    const sign = screen.getByTestId('public-quote-agree');
    const terms = screen.getByTestId('public-quote-terms-conditions');
    expect(sign.compareDocumentPosition(terms) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('links the signature checkbox to #terms only when T&C exist', () => {
    const { unmount } = render(<PublicQuoteView token="public-token" initial={DETAIL} />);
    const link = screen.getByTestId('public-quote-agree').closest('label')!.querySelector('a');
    expect(link?.getAttribute('href')).toBe('#terms');
    unmount();
    render(
      <PublicQuoteView token="public-token" initial={{ ...DETAIL, quote: { ...DETAIL.quote, termsAndConditions: null } }} />
    );
    expect(screen.getByTestId('public-quote-agree').closest('label')!.querySelector('a')).toBeNull();
  });

  it('stamps data-doc-theme="condensed" when the DTO resolves the condensed theme', () => {
    render(
      <PublicQuoteView
        token="public-token"
        initial={{ ...DETAIL, presentation: { theme: 'condensed', pageSize: 'letter' } }}
      />
    );
    expect(screen.getByTestId('public-quote').getAttribute('data-doc-theme')).toBe('condensed');
  });

  it('defaults data-doc-theme to "classic" when the DTO omits presentation', () => {
    render(<PublicQuoteView token="public-token" initial={DETAIL} />);
    expect(screen.getByTestId('public-quote').getAttribute('data-doc-theme')).toBe('classic');
  });
});

describe('PublicQuoteView decline confirmation', () => {
  // Regression: decline used to fire from window.prompt(), which returns null on
  // Cancel/Escape — coerced to undefined and passed straight to the API, so backing
  // out declined the proposal anyway. Nothing may reach the API but "Yes, decline".
  it('does not decline when the customer backs out with "Keep reviewing"', () => {
    const declineSpy = vi.spyOn(portalApi, 'declinePublicQuote');
    render(<PublicQuoteView token="public-token" initial={DETAIL} />);

    fireEvent.click(screen.getByTestId('public-quote-decline'));
    expect(screen.getByTestId('public-quote-decline-panel')).toBeTruthy();

    fireEvent.click(screen.getByTestId('public-quote-decline-cancel'));

    expect(declineSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('public-quote-decline-panel')).toBeNull();
    // Back to the normal row, still acceptable.
    expect(screen.getByTestId('public-quote-accept')).toBeTruthy();
  });

  it('declines with the optional reason only once "Yes, decline" is pressed', async () => {
    const declineSpy = vi
      .spyOn(portalApi, 'declinePublicQuote')
      .mockResolvedValue({ data: { data: { status: 'declined' } } });
    render(<PublicQuoteView token="public-token" initial={DETAIL} />);

    fireEvent.click(screen.getByTestId('public-quote-decline'));
    fireEvent.change(screen.getByTestId('public-quote-decline-reason'), {
      target: { value: 'Went with another vendor' },
    });
    expect(declineSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('public-quote-decline-confirm'));
    await waitFor(() =>
      expect(declineSpy).toHaveBeenCalledWith('public-token', 'Went with another vendor')
    );
  });
});

describe('PublicQuoteView accept validation', () => {
  // The Accept button stays enabled so a click can explain what is missing; a
  // disabled button takes neither focus nor click, so the hint was unreachable.
  it('explains what is missing instead of accepting when the form is incomplete', () => {
    const acceptSpy = vi.spyOn(portalApi, 'acceptPublicQuote');
    render(<PublicQuoteView token="public-token" initial={DETAIL} />);

    const accept = screen.getByTestId('public-quote-accept');
    expect(accept.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(accept);

    const hint = screen.getByTestId('public-quote-sign-hint');
    expect(hint.getAttribute('role')).toBe('alert');
    expect(hint.textContent).toContain('full name');
    expect(accept.getAttribute('aria-describedby')).toBe('public-quote-sign-hint');
    expect(acceptSpy).not.toHaveBeenCalled();
  });
});

describe('PublicQuoteView — cover page', () => {
  afterEach(cleanup);
  it('opens with the cover when the quote enables one: title, prepared for, prepared by, image', () => {
    render(
      <PublicQuoteView
        token="public-token"
        initial={{
          ...DETAIL,
          quote: {
            ...DETAIL.quote,
            coverPage: { enabled: true, title: 'Office Network Refresh Proposal', coverImageId: 'img-1', preparedForName: 'Acme Co', showPreparedBy: true },
          },
        }}
      />,
    );
    const cover = screen.getByTestId('doc-cover');
    expect(cover).toHaveTextContent('Office Network Refresh Proposal');
    expect(cover).toHaveTextContent('Prepared for');
    expect(cover).toHaveTextContent('Acme Co');
    expect(cover).toHaveTextContent('Prepared by');
    expect(cover).toHaveTextContent('Lantern IT');
    expect(cover.querySelector('img')?.getAttribute('src')).toContain('img-1');
    // One H1 on the page: the cover title. The header's number steps down.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Office Network Refresh Proposal');
    // Prepared-for is not repeated under the header.
    expect(screen.getAllByText('Prepared for')).toHaveLength(1);
  });

  it('renders no cover when the quote has none or it is switched off', () => {
    render(<PublicQuoteView token="public-token" initial={{ ...DETAIL, quote: { ...DETAIL.quote, coverPage: { enabled: false, title: 'x', coverImageId: null, preparedForName: null, showPreparedBy: true } } }} />);
    expect(screen.queryByTestId('doc-cover')).toBeNull();
  });
});

// A contract block (an agreement from a contract template) is long-form legal
// text. It used to render inline in the body, in block order — ahead of the
// totals — so a long agreement pushed the price and the sign button to the
// bottom of the page (#7040).
const MSA_BLOCK = {
  id: 'blk-msa',
  blockType: 'contract',
  sortOrder: 0,
  content: {
    label: 'Managed Services Agreement',
    templateName: 'MSA',
    versionNumber: 3,
    sourceType: 'authored',
    // 450 words → ~3 min at 200 wpm.
    renderedHtml: `<p>${'clause '.repeat(450)}</p>`,
    fileUrl: null,
  },
};
const UPLOADED_BLOCK = {
  id: 'blk-nda',
  blockType: 'contract',
  sortOrder: 1,
  content: {
    templateName: 'Mutual NDA',
    versionNumber: 1,
    sourceType: 'uploaded',
    renderedHtml: null,
    fileUrl: '/quotes/public/public-token/contract-file/blk-nda',
  },
};
const WITH_AGREEMENTS: PublicQuoteDetail = { ...DETAIL, blocks: [MSA_BLOCK, UPLOADED_BLOCK] };

describe('PublicQuoteView — agreements come after the price (#7040)', () => {
  const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('renders contract blocks after the totals and the sign panel, then the T&C', () => {
    render(<PublicQuoteView token="public-token" initial={WITH_AGREEMENTS} />);
    const [msa, nda] = screen.getAllByTestId('contract-block');
    expect(follows(screen.getByTestId('public-quote-due-on-acceptance'), msa!)).toBe(true);
    expect(follows(screen.getByTestId('public-quote-agree'), msa!)).toBe(true);
    expect(follows(msa!, nda!)).toBe(true);
    expect(follows(nda!, screen.getByTestId('public-quote-terms-conditions'))).toBe(true);
  });

  it('collapses each agreement by default and summarises it', () => {
    render(<PublicQuoteView token="public-token" initial={WITH_AGREEMENTS} />);
    const [msa, nda] = screen.getAllByTestId('contract-block') as HTMLDetailsElement[];
    expect(msa!.tagName).toBe('DETAILS');
    expect(msa!.open).toBe(false);
    expect(msa!.querySelector('summary')!.textContent).toContain('Managed Services Agreement');
    expect(msa!.querySelector('summary')!.textContent).toContain('~3 min read');
    expect(nda!.open).toBe(false);
    expect(nda!.querySelector('summary')!.textContent).toContain('Mutual NDA');
    expect(nda!.querySelector('summary')!.textContent).toContain('PDF');
  });

  it('does not load an uploaded agreement until it is opened', () => {
    render(<PublicQuoteView token="public-token" initial={WITH_AGREEMENTS} />);
    const nda = screen.getAllByTestId('contract-block')[1] as HTMLDetailsElement;
    expect(nda.querySelector('iframe')).toBeNull();
    nda.open = true;
    fireEvent(nda, new Event('toggle'));
    expect(nda.querySelector('iframe')?.getAttribute('src')).toContain('/contract-file/blk-nda');
    expect(screen.getByTestId('contract-block-download').getAttribute('href')).toContain('/contract-file/blk-nda');
  });

  it('opens an agreement from its #agreement-<id> deep link', async () => {
    window.location.hash = '#agreement-blk-msa';
    render(<PublicQuoteView token="public-token" initial={WITH_AGREEMENTS} />);
    await waitFor(() => expect((screen.getAllByTestId('contract-block')[0] as HTMLDetailsElement).open).toBe(true));
  });

  it('names and links every agreement in the signature checkbox', () => {
    render(<PublicQuoteView token="public-token" initial={WITH_AGREEMENTS} />);
    const label = screen.getByTestId('public-quote-agree').closest('label')!;
    const links = [...label.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['Managed Services Agreement', '#agreement-blk-msa'],
      ['Mutual NDA', '#agreement-blk-nda'],
      ['Terms & Conditions', '#terms'],
    ]);
    expect(label.textContent).toContain('Managed Services Agreement, Mutual NDA and Terms & Conditions');
  });

  it('clicking an agreement link in the checkbox opens that agreement', () => {
    render(<PublicQuoteView token="public-token" initial={WITH_AGREEMENTS} />);
    const msa = screen.getAllByTestId('contract-block')[0] as HTMLDetailsElement;
    const link = screen.getByTestId('public-quote-agree').closest('label')!.querySelector('a')!;
    fireEvent.click(link);
    expect(msa.open).toBe(true);
  });

  it('expands every agreement for print and restores after', () => {
    render(<PublicQuoteView token="public-token" initial={WITH_AGREEMENTS} />);
    const rows = screen.getAllByTestId('contract-block') as HTMLDetailsElement[];
    fireEvent(window, new Event('beforeprint'));
    expect(rows.every((r) => r.open)).toBe(true);
    fireEvent(window, new Event('afterprint'));
    expect(rows.some((r) => r.open)).toBe(false);
  });

  // The browser snapshots the page for print right after `beforeprint`
  // returns. A plain dispatch (no act()) is how the browser fires it: React
  // must have committed the open rows by the time the handler returns, not on
  // a later task (fireEvent's act() wrapper would hide exactly that delay).
  it('opens every row synchronously inside beforeprint', () => {
    render(<PublicQuoteView token="public-token" initial={WITH_AGREEMENTS} />);
    const rows = [
      ...screen.getAllByTestId('contract-block'),
      screen.getByTestId('public-quote-terms-conditions'),
    ] as HTMLDetailsElement[];
    window.dispatchEvent(new Event('beforeprint'));
    expect(rows.map((r) => r.open)).toEqual([true, true, true]);
    window.dispatchEvent(new Event('afterprint'));
    expect(rows.map((r) => r.open)).toEqual([false, false, false]);
  });

  it('keeps contract blocks out of the proposal body', () => {
    render(<PublicQuoteView token="public-token" initial={WITH_AGREEMENTS} />);
    const agreements = screen.getByTestId('public-quote-agreements');
    for (const row of screen.getAllByTestId('contract-block')) expect(agreements.contains(row)).toBe(true);
  });
});
