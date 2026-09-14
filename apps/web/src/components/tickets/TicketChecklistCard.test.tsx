import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import TicketChecklistCard from './TicketChecklistCard';

type Item = ReturnType<typeof item>;

function item(over: Record<string, unknown> = {}): {
  id: string;
  ticketId: string;
  label: string;
  detail: string | null;
  position: number;
  done: boolean;
  doneAt: string | null;
  doneByUserId: string | null;
  source: string;
  sourceTemplateItemId: string | null;
  createdAt: string;
} {
  return {
    id: 'i-1',
    ticketId: 'tk-1',
    label: 'Check the sign-in log',
    detail: null,
    position: 0,
    done: false,
    doneAt: null,
    doneByUserId: null,
    source: 'manual',
    sourceTemplateItemId: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

const jsonRes = (data: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => ({ data }) }) as Response;

const checklistUrl = () => '/tickets/tk-1/checklist';
const itemUrl = (id: string) => `/tickets/checklist/${id}`;

/** A minimal stateful fake server backed by `items`, mirroring what the real
 *  checklist REST surface does for the shapes this component calls. */
function fakeServer(items: Item[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === checklistUrl() && method === 'GET') {
      return jsonRes({ items, done: items.filter((i) => i.done).length, total: items.length });
    }
    if (url === checklistUrl() && method === 'POST') {
      const body = JSON.parse(init!.body as string) as { label: string; detail?: string };
      const created = item({ id: `new-${items.length + 1}`, label: body.label, detail: body.detail ?? null });
      items.push(created);
      return jsonRes(created, 201);
    }
    if (url === `${checklistUrl()}/reorder` && method === 'POST') {
      const body = JSON.parse(init!.body as string) as { itemIds: string[] };
      const reordered = body.itemIds.map((id) => items.find((i) => i.id === id)!);
      return jsonRes({ items: reordered, done: reordered.filter((i) => i.done).length, total: reordered.length });
    }
    if (url.startsWith('/tickets/checklist/') && method === 'PATCH') {
      const id = url.slice('/tickets/checklist/'.length);
      const body = JSON.parse(init!.body as string) as { label?: string; detail?: string | null; done?: boolean };
      const existing = items.find((i) => i.id === id)!;
      const patched: Item = { ...existing };
      if (body.label !== undefined) patched.label = body.label;
      if (body.detail !== undefined) patched.detail = body.detail;
      if (body.done !== undefined) {
        patched.done = body.done;
        patched.doneAt = body.done ? '2026-09-14T00:00:00.000Z' : null;
        patched.doneByUserId = body.done ? 'u-1' : null;
      }
      return jsonRes(patched);
    }
    if (url.startsWith('/tickets/checklist/') && method === 'DELETE') {
      return jsonRes({ deleted: true });
    }
    return jsonRes({});
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('TicketChecklistCard', () => {
  it('shows derived progress', async () => {
    fetchWithAuth.mockImplementation(fakeServer([item({ id: 'i-1', done: true }), item({ id: 'i-2', label: 'Second step' })]));
    render(<TicketChecklistCard ticketId="tk-1" />);
    expect(await screen.findByTestId('ticket-checklist-progress')).toHaveTextContent('1 / 2');
  });

  it('renders nothing (full mode) when the checklist is empty', async () => {
    fetchWithAuth.mockImplementation(fakeServer([]));
    const { container } = render(<TicketChecklistCard ticketId="tk-1" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(checklistUrl()));
    await waitFor(() => expect(container.querySelector('[data-testid="ticket-checklist-card"]')).toBeNull());
  });

  it('ticks a step with a PATCH carrying exactly { done: true }', async () => {
    fetchWithAuth.mockImplementation(fakeServer([item({ id: 'i-1', done: false })]));
    render(<TicketChecklistCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-checklist-toggle-i-1'));
    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(
        (args) => args[0] === itemUrl('i-1') && (args[1] as RequestInit)?.method === 'PATCH',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toEqual({ done: true });
      expect(body).not.toHaveProperty('doneAt');
      expect(body).not.toHaveProperty('doneByUserId');
    });
  });

  it('shows the edit warning for a DONE step', async () => {
    fetchWithAuth.mockImplementation(
      fakeServer([item({ id: 'i-1', done: true, doneAt: '2026-09-10T00:00:00.000Z', doneByUserId: 'u-1' })]),
    );
    render(<TicketChecklistCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-checklist-edit-i-1'));
    expect(await screen.findByTestId('ticket-checklist-edit-warning')).toBeTruthy();
  });

  it('does NOT show the edit warning for an unticked step', async () => {
    fetchWithAuth.mockImplementation(fakeServer([item({ id: 'i-1', done: false })]));
    render(<TicketChecklistCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-checklist-edit-i-1'));
    // Give the (non-existent) warning a chance to appear before asserting absence.
    await screen.findByTestId('ticket-checklist-edit-label-i-1');
    expect(screen.queryByTestId('ticket-checklist-edit-warning')).toBeNull();
  });

  it('reorders by POSTing the complete id list', async () => {
    fetchWithAuth.mockImplementation(
      fakeServer([item({ id: 'i-1', position: 0 }), item({ id: 'i-2', label: 'Second', position: 1 })]),
    );
    render(<TicketChecklistCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-checklist-down-i-1'));
    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(
        (args) => args[0] === `${checklistUrl()}/reorder` && (args[1] as RequestInit)?.method === 'POST',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toEqual({ itemIds: ['i-2', 'i-1'] });
    });
  });

  it('adds a step', async () => {
    fetchWithAuth.mockImplementation(fakeServer([item({ id: 'i-1' })]));
    render(<TicketChecklistCard ticketId="tk-1" />);
    fireEvent.change(await screen.findByTestId('ticket-checklist-add-input'), { target: { value: 'New step' } });
    fireEvent.click(screen.getByTestId('ticket-checklist-add'));
    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(
        (args) => args[0] === checklistUrl() && (args[1] as RequestInit)?.method === 'POST',
      );
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ label: 'New step' });
    });
  });

  it('deletes a step', async () => {
    fetchWithAuth.mockImplementation(fakeServer([item({ id: 'i-1' })]));
    render(<TicketChecklistCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-checklist-delete-i-1'));
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(itemUrl('i-1'), expect.objectContaining({ method: 'DELETE' })),
    );
  });

  it('compact mode hides add/reorder/delete but keeps the toggle', async () => {
    fetchWithAuth.mockImplementation(fakeServer([item({ id: 'i-1' })]));
    render(<TicketChecklistCard ticketId="tk-1" mode="compact" />);
    expect(await screen.findByTestId('ticket-checklist-toggle-i-1')).toBeTruthy();
    expect(screen.queryByTestId('ticket-checklist-add')).toBeNull();
    expect(screen.queryByTestId('ticket-checklist-up-i-1')).toBeNull();
    expect(screen.queryByTestId('ticket-checklist-down-i-1')).toBeNull();
    expect(screen.queryByTestId('ticket-checklist-delete-i-1')).toBeNull();
  });

  it('renders an XSS-shaped label as text with no img element', async () => {
    const malicious = '<img src=x onerror=alert(1)>';
    fetchWithAuth.mockImplementation(fakeServer([item({ id: 'i-1', label: malicious })]));
    render(<TicketChecklistCard ticketId="tk-1" />);
    const row = await screen.findByTestId('ticket-checklist-item-i-1');
    expect(row.textContent).toContain(malicious);
    expect(within(row).queryByRole('img')).toBeNull();
    expect(row.querySelector('img')).toBeNull();
  });

  it('fires onCountsChange after the initial load', async () => {
    const onCountsChange = vi.fn();
    fetchWithAuth.mockImplementation(fakeServer([item({ id: 'i-1', done: true }), item({ id: 'i-2' })]));
    render(<TicketChecklistCard ticketId="tk-1" onCountsChange={onCountsChange} />);
    await waitFor(() => expect(onCountsChange).toHaveBeenCalledWith({ done: 1, total: 2, known: true }));
  });

  it('fires onCountsChange after a successful mutation', async () => {
    const onCountsChange = vi.fn();
    fetchWithAuth.mockImplementation(fakeServer([item({ id: 'i-1', done: false })]));
    render(<TicketChecklistCard ticketId="tk-1" onCountsChange={onCountsChange} />);
    await waitFor(() => expect(onCountsChange).toHaveBeenCalledWith({ done: 0, total: 1, known: true }));
    fireEvent.click(await screen.findByTestId('ticket-checklist-toggle-i-1'));
    await waitFor(() => expect(onCountsChange).toHaveBeenCalledWith({ done: 1, total: 1, known: true }));
  });

  it('reports known:false when the checklist FAILS to load, instead of a 0/0 that reads as "no checklist"', async () => {
    // The whole point of `known`: a failed fetch leaves the card at 0/0, which
    // is byte-identical to a ticket that genuinely has no checklist. Reporting
    // that as a real count silently disables TicketWorkbench's resolve/close
    // prompt on a network blip.
    const onCountsChange = vi.fn();
    fetchWithAuth.mockImplementation(async () => jsonRes(null, 500));
    render(<TicketChecklistCard ticketId="tk-1" onCountsChange={onCountsChange} />);
    await waitFor(() => expect(onCountsChange).toHaveBeenCalledWith({ done: 0, total: 0, known: false }));
    expect(onCountsChange).not.toHaveBeenCalledWith({ done: 0, total: 0, known: true });
  });

  it('shows an error with a retry instead of vanishing when the load fails', async () => {
    // `return null` on an empty checklist is deliberate; doing it on a FAILED
    // load would leave the technician no affordance telling them the checklist
    // they cannot see might not be empty.
    fetchWithAuth.mockImplementation(async () => jsonRes(null, 500));
    render(<TicketChecklistCard ticketId="tk-1" />);
    expect(await screen.findByTestId('ticket-checklist-error')).toBeInTheDocument();

    fetchWithAuth.mockImplementation(fakeServer([item({ id: 'i-1' })]));
    fireEvent.click(screen.getByTestId('ticket-checklist-retry'));
    expect(await screen.findByTestId('ticket-checklist-item-i-1')).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-checklist-error')).toBeNull();
  });
});
