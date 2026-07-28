// The quote title is a blur-to-save field in the workspace HEADER, so its
// reported state feeds the Send gate directly. It reported `busy || dirty` as
// "pending" and cleared `dirty` only on success — so one failed PATCH pinned
// "Saving changes… Send unlocks when everything is saved." over the Send button
// for the rest of the session, describing a save that had already given up.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { QuoteHeaderMeta } from './QuoteHeaderMeta';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { fetchWithAuth } from '../../../stores/auth';

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../../stores/orgStore', () => ({
  useOrgStore: (sel: (s: { organizations: unknown[] }) => unknown) => sel({ organizations: [] }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function detail(): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: 'Q-1', partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '0.00', billToName: null, introNotes: null,
      terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
      convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null,
      createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
    },
    blocks: [],
    lines: [],
  };
}

beforeEach(() => vi.clearAllMocks());

describe('QuoteHeaderMeta — title save reporting', () => {
  it('a dirty title is not "pending"; only the in-flight PATCH is', async () => {
    let resolvePatch!: (v: Response) => void;
    fetchMock.mockImplementation(async () => new Promise<Response>((r) => { resolvePatch = r; }));
    const onPending = vi.fn();

    render(<QuoteHeaderMeta detail={detail()} onChanged={vi.fn()} onPendingChange={onPending} />);
    expect(onPending).toHaveBeenLastCalledWith(false);

    const input = screen.getByTestId('quote-title');
    fireEvent.change(input, { target: { value: 'Renewal' } });
    // Typing has sent nothing. The Send gate still holds, because the Send
    // click itself blurs this field and the resulting save lands first.
    expect(onPending).toHaveBeenLastCalledWith(false);

    fireEvent.blur(input);
    await waitFor(() => expect(onPending).toHaveBeenLastCalledWith(true));

    resolvePatch(json({ data: {} }));
    await waitFor(() => expect(onPending).toHaveBeenLastCalledWith(false));
  });

  it('a FAILED title save reports an unsaved field and stops claiming to be saving', async () => {
    let fail = true;
    fetchMock.mockImplementation(async () => (fail ? json({ error: 'no' }, false, 500) : json({ data: {} })));
    const onPending = vi.fn();
    const onUnsaved = vi.fn();

    render(
      <QuoteHeaderMeta detail={detail()} onChanged={vi.fn()} onPendingChange={onPending} onUnsavedChange={onUnsaved} />,
    );

    const input = screen.getByTestId('quote-title');
    fireEvent.change(input, { target: { value: 'Renewal' } });
    fireEvent.blur(input);

    await waitFor(() => expect(onUnsaved).toHaveBeenLastCalledWith('Quote title'));
    expect(onPending).toHaveBeenLastCalledWith(false);

    // A successful retry lifts the block.
    fail = false;
    fireEvent.change(input, { target: { value: 'Renewal v2' } });
    fireEvent.blur(input);
    await waitFor(() => expect(onUnsaved).toHaveBeenLastCalledWith(null));
  });

  it('a FAILED title save bumps the workspace failure nonce (onSaveFailure); a success does not', async () => {
    // Without this signal a queued Send saw only "quiet" once titleBusy
    // cleared, and the composer opened carrying the stale title. The nonce is
    // what cancels it (same contract as QuoteEditor's onSaveFailure).
    let fail = true;
    fetchMock.mockImplementation(async () => (fail ? json({ error: 'no' }, false, 500) : json({ data: {} })));
    const onSaveFailure = vi.fn();

    render(<QuoteHeaderMeta detail={detail()} onChanged={vi.fn()} onSaveFailure={onSaveFailure} />);

    const input = screen.getByTestId('quote-title');
    fireEvent.change(input, { target: { value: 'Renewal' } });
    fireEvent.blur(input);
    await waitFor(() => expect(onSaveFailure).toHaveBeenCalledTimes(1));

    // A successful save reports nothing — the nonce only counts FAILURES.
    fail = false;
    fireEvent.change(input, { target: { value: 'Renewal v2' } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByTestId('quote-title')).not.toBeDisabled());
    expect(onSaveFailure).toHaveBeenCalledTimes(1);
  });
});
