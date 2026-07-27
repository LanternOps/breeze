// The quiet "Saving…" / "Saved 2:41 PM" sync indicator near the autosave hint
// (InvoiceEditor.tsx — the quote editor's save-language, normalized onto
// invoices). Uses the notes-field PATCH as the mutation under test — same
// runScoped path every other editor mutation goes through. Also pins the
// onPendingEditsChange contract the workspace's Issue gating relies on.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceEditor from './InvoiceEditor';
import type { InvoiceDetail } from './invoiceTypes';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function draft(): InvoiceDetail {
  return {
    invoice: {
      id: 'inv-1', invoiceNumber: null, orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, dueDate: null, sentAt: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', amountPaid: '0.00', balance: '0.00', billToName: 'Acme',
      notes: '', termsAndConditions: null, sellerSnapshot: null, createdAt: '2026-06-01T00:00:00Z',
    },
    lines: [],
  };
}

describe('InvoiceEditor — autosave hint + last-saved indicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      return json({ data: {} });
    });
  });

  it('is absent before any save, shows "Saving…" while the mutation is in flight, then "Saved <time>" once it settles', async () => {
    let resolvePatch!: (v: Response) => void;
    const patchPromise = new Promise<Response>((resolve) => { resolvePatch = resolve; });
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1' && opts?.method === 'PATCH') return patchPromise;
      return json({ data: {} });
    });

    render(<InvoiceEditor detail={draft()} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    // The autosave hint renders for writers from the start…
    expect(screen.getByTestId('invoice-editor-autosave-hint')).toBeInTheDocument();
    // …but nothing has saved yet this session — the indicator renders nothing at
    // all (never an empty "Saved" line) rather than blocking anything.
    expect(screen.queryByTestId('invoice-editor-last-saved')).not.toBeInTheDocument();

    const textarea = screen.getByTestId('invoice-notes');
    fireEvent.change(textarea, { target: { value: 'Thanks for your business' } });
    fireEvent.blur(textarea);

    await waitFor(() => expect(screen.getByTestId('invoice-editor-last-saved')).toHaveTextContent('Saving'));

    resolvePatch(json({ data: {} }));

    await waitFor(() => expect(screen.getByTestId('invoice-editor-last-saved')).toHaveTextContent(/Saved/));
    expect(screen.getByTestId('invoice-editor-last-saved')).not.toHaveTextContent('Saving');
  });

  it('does NOT stamp "Saved" when the save fails — the indicator must never lie on a money document', async () => {
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1' && opts?.method === 'PATCH') return json({ error: { message: 'boom' } }, false, 500);
      return json({ data: {} });
    });
    const onSaveFailure = vi.fn();
    render(<InvoiceEditor detail={draft()} onChanged={vi.fn()} onSaveFailure={onSaveFailure} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    const textarea = screen.getByTestId('invoice-notes');
    fireEvent.change(textarea, { target: { value: 'Doomed edit' } });
    fireEvent.blur(textarea);

    await waitFor(() => expect(onSaveFailure).toHaveBeenCalled());
    // No successful save this session → no "Saved <time>" line at all.
    expect(screen.queryByTestId('invoice-editor-last-saved')).not.toBeInTheDocument();
  });

  it('reports pending edits to the workspace: true while dirty/in-flight, false once settled and on unmount', async () => {
    let resolvePatch!: (v: Response) => void;
    const patchPromise = new Promise<Response>((resolve) => { resolvePatch = resolve; });
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1' && opts?.method === 'PATCH') return patchPromise;
      return json({ data: {} });
    });
    const onPending = vi.fn();

    const { unmount } = render(<InvoiceEditor detail={draft()} onChanged={vi.fn()} onPendingEditsChange={onPending} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());
    expect(onPending).toHaveBeenLastCalledWith(false);

    // Typing makes the notes field dirty — pending flips true immediately (the
    // Issue gate must hold from the first keystroke, not from blur).
    const textarea = screen.getByTestId('invoice-notes');
    fireEvent.change(textarea, { target: { value: 'Edited' } });
    await waitFor(() => expect(onPending).toHaveBeenLastCalledWith(true));

    // Blur starts the save; while the PATCH is in flight it stays pending.
    fireEvent.blur(textarea);
    expect(onPending).toHaveBeenLastCalledWith(true);

    resolvePatch(json({ data: {} }));
    await waitFor(() => expect(onPending).toHaveBeenLastCalledWith(false));

    // Unmount clears the flag so a stale `true` can't lock the header actions.
    onPending.mockClear();
    unmount();
    expect(onPending).toHaveBeenLastCalledWith(false);
  });
});
