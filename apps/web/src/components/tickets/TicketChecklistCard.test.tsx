import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import TicketChecklistCard from './TicketChecklistCard';
import { showToast } from '../shared/Toast';

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
  operatorTaskId: string | null;
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
    operatorTaskId: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

const jsonRes = (data: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => ({ data }) }) as Response;

const checklistUrl = () => '/tickets/tk-1/checklist';
const itemUrl = (id: string) => `/tickets/checklist/${id}`;

function template(over: Record<string, unknown> = {}) {
  return {
    id: 'tpl-1',
    orgId: 'o-1',
    partnerId: null,
    ownerScope: 'organization',
    name: 'Device onboarding',
    description: null,
    instructions: null,
    isActive: true,
    items: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

/** A minimal stateful fake server backed by `items`, mirroring what the real
 *  checklist REST surface does for the shapes this component calls. */
function fakeServer(items: Item[], templates: ReturnType<typeof template>[] = []) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.startsWith('/ticket-checklist-templates') && method === 'GET') {
      return jsonRes(templates);
    }
    if (url === `${checklistUrl()}/apply-template` && method === 'POST') {
      const body = JSON.parse(init!.body as string) as { templateId: string };
      const applied = item({ id: `applied-${body.templateId}`, label: 'Step from template', source: 'checklist_template' });
      items.push(applied);
      return jsonRes({ items, done: items.filter((i) => i.done).length, total: items.length });
    }
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

  // ── Apply template (#5808 W02) ──────────────────────────────────────────

  it('offers Apply template on an EMPTY checklist when templates exist', async () => {
    // This is what gives W01's card a reachable entry point: an empty checklist
    // otherwise renders nothing at all.
    fetchWithAuth.mockImplementation(fakeServer([], [template()]));
    render(<TicketChecklistCard ticketId="tk-1" />);
    expect(await screen.findByTestId('ticket-checklist-apply-template')).toBeInTheDocument();
  });

  it('renders NOTHING on an empty checklist when no templates are visible', async () => {
    fetchWithAuth.mockImplementation(fakeServer([], []));
    const { container } = render(<TicketChecklistCard ticketId="tk-1" />);
    await waitFor(() => expect(screen.queryByTestId('ticket-checklist-card')).toBeNull());
    expect(container.textContent).toBe('');
  });

  it('filters INACTIVE templates out of the picker', async () => {
    fetchWithAuth.mockImplementation(
      fakeServer([], [template({ id: 'tpl-off', isActive: false })]),
    );
    const { container } = render(<TicketChecklistCard ticketId="tk-1" />);
    await waitFor(() => expect(screen.queryByTestId('ticket-checklist-card')).toBeNull());
    expect(container.textContent).toBe('');
  });

  it('marks the All orgs templates in the picker', async () => {
    fetchWithAuth.mockImplementation(
      fakeServer([], [template({ id: 'tpl-shared', orgId: null, partnerId: 'p-1', ownerScope: 'partner' })]),
    );
    render(<TicketChecklistCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-checklist-apply-template'));
    const option = await screen.findByTestId('ticket-checklist-template-option-tpl-shared');
    expect(option.textContent).toMatch(/All orgs/i);
  });

  it('POSTs the chosen template with the chosen mode', async () => {
    fetchWithAuth.mockImplementation(fakeServer([item({ id: 'i-1' })], [template()]));
    render(<TicketChecklistCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-checklist-apply-template'));
    fireEvent.change(await screen.findByTestId('ticket-checklist-template-select'), {
      target: { value: 'tpl-1' },
    });
    fireEvent.click(screen.getByTestId('ticket-checklist-apply-mode-replace'));
    fireEvent.click(screen.getByTestId('ticket-checklist-apply-submit'));

    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(
        ([u]) => u === '/tickets/tk-1/checklist/apply-template',
      );
      expect(call).toBeDefined();
      expect(JSON.parse(call![1].body)).toEqual({
        templateId: 'tpl-1',
        mode: 'replace_unticked',
      });
    });
  });

  it('defaults the mode to append', async () => {
    fetchWithAuth.mockImplementation(fakeServer([item({ id: 'i-1' })], [template()]));
    render(<TicketChecklistCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-checklist-apply-template'));
    fireEvent.change(await screen.findByTestId('ticket-checklist-template-select'), {
      target: { value: 'tpl-1' },
    });
    fireEvent.click(screen.getByTestId('ticket-checklist-apply-submit'));

    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(
        ([u]) => u === '/tickets/tk-1/checklist/apply-template',
      );
      expect(call).toBeDefined();
      expect(JSON.parse(call![1].body).mode).toBe('append');
    });
  });

  it('does NOT vanish when the TEMPLATE fetch fails on an empty checklist', async () => {
    // A failed template fetch (401/403/500) must not render identically to
    // "this MSP has no templates" — that would hide the card entirely and give
    // the technician no signal that anything went wrong.
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.startsWith('/ticket-checklist-templates')) return jsonRes(null, 500);
      return jsonRes({ items: [], done: 0, total: 0 });
    });
    render(<TicketChecklistCard ticketId="tk-1" />);
    expect(await screen.findByTestId('ticket-checklist-templates-error')).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-checklist-apply-template')).toBeNull();
  });

  it('recovers the picker when the template retry succeeds', async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.startsWith('/ticket-checklist-templates')) return jsonRes(null, 500);
      return jsonRes({ items: [], done: 0, total: 0 });
    });
    render(<TicketChecklistCard ticketId="tk-1" />);
    await screen.findByTestId('ticket-checklist-templates-error');

    fetchWithAuth.mockImplementation(fakeServer([], [template()]));
    fireEvent.click(screen.getByTestId('ticket-checklist-templates-retry'));
    expect(await screen.findByTestId('ticket-checklist-apply-template')).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-checklist-templates-error')).toBeNull();
  });

  it('compact mode does NOT offer Apply template', async () => {
    fetchWithAuth.mockImplementation(fakeServer([item({ id: 'i-1' })], [template()]));
    render(<TicketChecklistCard ticketId="tk-1" mode="compact" />);
    await screen.findByTestId('ticket-checklist-item-i-1');
    expect(screen.queryByTestId('ticket-checklist-apply-template')).toBeNull();
  });
});

describe('operator_task items (recipe spec §6.5)', () => {
  it('renders the Operator badge and a link to the task', async () => {
    const server = fakeServer([
      item({ id: 'it-op', label: 'Collect the laptop', source: 'operator_task', operatorTaskId: 'task-9' }),
    ]);
    fetchWithAuth.mockImplementation(server);
    render(<TicketChecklistCard ticketId="tk-1" />);
    expect(await screen.findByTestId('ticket-checklist-operator-badge-it-op')).toBeInTheDocument();
    const link = screen.getByTestId('ticket-checklist-operator-link-it-op');
    // The UI route, not the API path: /operator/tasks/:id (the href
    // DelegateToOperatorButton.tsx:115 already navigates to).
    expect(link).toHaveAttribute('href', '/operator/tasks/task-9');
  });

  it('renders the badge WITHOUT a link when the task is not resolvable', async () => {
    // operatorTaskId is null when the step lives in another org — a ticket that
    // has been moved between orgs. The badge still explains where the step came
    // from; the link would point into another tenant.
    const server = fakeServer([
      item({ id: 'it-moved', source: 'operator_task', operatorTaskId: null }),
    ]);
    fetchWithAuth.mockImplementation(server);
    render(<TicketChecklistCard ticketId="tk-1" />);
    expect(await screen.findByTestId('ticket-checklist-operator-badge-it-moved')).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-checklist-operator-link-it-moved')).toBeNull();
  });

  it('shows no badge on a manual item', async () => {
    const server = fakeServer([item({ id: 'it-man', source: 'manual' })]);
    fetchWithAuth.mockImplementation(server);
    render(<TicketChecklistCard ticketId="tk-1" />);
    await screen.findByTestId('ticket-checklist-item-it-man');
    expect(screen.queryByTestId('ticket-checklist-operator-badge-it-man')).toBeNull();
  });

  it('still lets a human tick an operator_task item — the Operator waits on exactly this', async () => {
    // Guarding against an over-eager "it belongs to a robot, make it read-only".
    // The tick is the ONLY way a human_work step ever completes.
    const server = fakeServer([item({ id: 'it-op', source: 'operator_task', operatorTaskId: 'task-9' })]);
    fetchWithAuth.mockImplementation(server);
    render(<TicketChecklistCard ticketId="tk-1" />);
    const toggle = await screen.findByTestId('ticket-checklist-toggle-it-op');
    expect(toggle).not.toBeDisabled();
  });

  it('surfaces the 409 refusal when deleting an item a task is waiting on', async () => {
    // runClientAction + the FRIENDLY code map. A silent no-op here would look
    // to the technician exactly like a successful delete.
    const items = [item({ id: 'it-op', source: 'operator_task', operatorTaskId: 'task-9' })];
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url === checklistUrl() && method === 'GET') {
        return jsonRes({ items, done: 0, total: items.length });
      }
      if (url.startsWith('/tickets/checklist/') && method === 'DELETE') {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: 'An Operator task is waiting on this step.', code: 'CHECKLIST_OPERATOR_STEP_WAITING' }),
        } as Response;
      }
      return jsonRes({});
    });
    render(<TicketChecklistCard ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-checklist-delete-it-op'));
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'An Operator task is still waiting on this step, so it can\'t be deleted. Tick it when the work is done, or stop the task first.' }),
      );
    });
    // The item must still be present — the delete was refused, not silently dropped.
    expect(screen.getByTestId('ticket-checklist-item-it-op')).toBeInTheDocument();
  });
});
