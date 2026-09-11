import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@/lib/i18n';
import OrgKeyDatesCard from './OrgKeyDatesCard';
import type { OrgFetch } from './orgRecordFetch';
import type { KeyDate } from '@/lib/api/orgKeyDates';

const ambientFetch = vi.fn();
vi.mock('@/stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/auth')>();
  return { ...actual, fetchWithAuth: (...args: unknown[]) => ambientFetch(...args) };
});

const showToast = vi.fn();
vi.mock('@/components/shared/Toast', () => ({ showToast: (...args: unknown[]) => showToast(...args) }));

const ORG_ID = 'org-record-1';
const BASE = `/orgs/${ORG_ID}/key-dates`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function keyDate(overrides: Partial<KeyDate> = {}): KeyDate {
  return {
    source: 'key_date',
    id: 'kd-1',
    label: 'Cyber insurance renewal',
    kind: 'insurance_renewal',
    date: '2026-11-01',
    recursAnnually: true,
    remindDaysBefore: 30,
    ownerUserId: null,
    portalVisible: false,
    notes: null,
    contractId: null,
    ...overrides,
  };
}

const CONTRACT_END = keyDate({
  source: 'contract_end',
  id: 'contract:c-1',
  label: 'Gold support',
  kind: 'other',
  date: '2026-10-15',
  recursAnnually: false,
  remindDaysBefore: null,
  contractId: 'c-1',
});

type Call = [string, (RequestInit & { method?: string }) | undefined];

/** In-memory key-dates API: list, create, patch, delete — all under the org path. */
function fetchFor(initial: KeyDate[]): { orgFetch: OrgFetch; calls: () => Call[] } {
  let rows = [...initial];
  const fn = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path === BASE && method === 'GET') return json({ data: rows });
    if (path === BASE && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Partial<KeyDate>;
      const created = keyDate({ ...body, id: 'kd-new', source: 'key_date' });
      rows = [...rows, created];
      return json({ data: created }, 201);
    }
    if (path.startsWith(`${BASE}/`) && method === 'PATCH') {
      const id = decodeURIComponent(path.slice(BASE.length + 1));
      const body = JSON.parse(String(init?.body)) as Partial<KeyDate>;
      rows = rows.map((r) => (r.id === id ? { ...r, ...body } : r));
      return json({ data: rows.find((r) => r.id === id) });
    }
    if (path.startsWith(`${BASE}/`) && method === 'DELETE') {
      const id = decodeURIComponent(path.slice(BASE.length + 1));
      rows = rows.filter((r) => r.id !== id);
      return new Response(null, { status: 204 });
    }
    return json({ error: 'unexpected' }, 500);
  });
  return { orgFetch: fn as unknown as OrgFetch, calls: () => fn.mock.calls as unknown as Call[] };
}

afterEach(() => {
  ambientFetch.mockClear();
  showToast.mockClear();
});

describe('OrgKeyDatesCard', () => {
  it('lists rows by date through orgFetch; contract ends are read-only, key dates are editable', async () => {
    const { orgFetch, calls } = fetchFor([keyDate(), CONTRACT_END]);
    render(<OrgKeyDatesCard orgId={ORG_ID} orgFetch={orgFetch} />);

    const contractRow = await screen.findByTestId('key-date-row-contract:c-1');
    const keyRow = screen.getByTestId('key-date-row-kd-1');

    // Sorted by date: the contract end (Oct 15) precedes the insurance renewal (Nov 1).
    const card = screen.getByTestId('org-key-dates');
    const ids = Array.from(card.querySelectorAll('[data-testid^="key-date-row-"]')).map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['key-date-row-contract:c-1', 'key-date-row-kd-1']);

    expect(within(contractRow).getByText('Contract end')).toBeTruthy();
    expect(within(contractRow).queryByTestId('key-date-edit-contract:c-1')).toBeNull();
    expect(within(contractRow).queryByTestId('key-date-delete-contract:c-1')).toBeNull();

    expect(within(keyRow).getByText('Insurance renewal')).toBeTruthy();
    expect(within(keyRow).getByTestId('key-date-edit-kd-1')).toBeTruthy();
    expect(within(keyRow).getByTestId('key-date-delete-kd-1')).toBeTruthy();

    expect(calls().some(([path]) => path === BASE)).toBe(true);
    expect(ambientFetch).not.toHaveBeenCalled();
  });

  it('shows the empty copy when there are no key dates', async () => {
    const { orgFetch } = fetchFor([]);
    render(<OrgKeyDatesCard orgId={ORG_ID} orgFetch={orgFetch} />);
    await waitFor(() => expect(screen.getByTestId('org-key-dates').textContent).toContain('No key dates recorded.'));
  });

  it('creates a key date by POSTing the form through orgFetch and toasts on success', async () => {
    const { orgFetch, calls } = fetchFor([]);
    render(<OrgKeyDatesCard orgId={ORG_ID} orgFetch={orgFetch} />);
    await screen.findByTestId('key-date-add');
    expect(screen.queryByTestId('key-date-form')).toBeNull();

    await userEvent.click(screen.getByTestId('key-date-add'));
    const form = await screen.findByTestId('key-date-form');
    await userEvent.type(within(form).getByLabelText('Label'), 'SOC 2 audit');
    await userEvent.selectOptions(within(form).getByLabelText('Type'), 'audit');
    const dateInput = within(form).getByLabelText('Date') as HTMLInputElement;
    await userEvent.clear(dateInput);
    await userEvent.type(dateInput, '2027-03-01');
    await userEvent.click(within(form).getByLabelText('Show in customer portal'));
    await userEvent.clear(within(form).getByLabelText('Remind (days before)'));
    await userEvent.type(within(form).getByLabelText('Remind (days before)'), '14');
    await userEvent.click(screen.getByTestId('key-date-form-save'));

    await waitFor(() => expect(screen.getByTestId('key-date-row-kd-new')).toBeTruthy());
    const post = calls().find(([path, init]) => path === BASE && init?.method === 'POST');
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post![1]!.body))).toEqual({
      label: 'SOC 2 audit',
      kind: 'audit',
      date: '2027-03-01',
      recursAnnually: false,
      remindDaysBefore: 14,
      portalVisible: true,
      notes: null,
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Key date saved' }));
    expect(screen.queryByTestId('key-date-form')).toBeNull();
    expect(ambientFetch).not.toHaveBeenCalled();
  });

  it('edits an existing key date with a PATCH through orgFetch', async () => {
    const { orgFetch, calls } = fetchFor([keyDate()]);
    render(<OrgKeyDatesCard orgId={ORG_ID} orgFetch={orgFetch} />);
    await userEvent.click(await screen.findByTestId('key-date-edit-kd-1'));
    const form = await screen.findByTestId('key-date-form');
    const label = within(form).getByLabelText('Label') as HTMLInputElement;
    expect(label.value).toBe('Cyber insurance renewal');
    await userEvent.clear(label);
    await userEvent.type(label, 'Cyber cover');
    await userEvent.click(screen.getByTestId('key-date-form-save'));

    await waitFor(() => expect(screen.getByTestId('key-date-row-kd-1').textContent).toContain('Cyber cover'));
    const patch = calls().find(([path, init]) => path === `${BASE}/kd-1` && init?.method === 'PATCH');
    expect(patch).toBeTruthy();
    expect(JSON.parse(String(patch![1]!.body))).toMatchObject({ label: 'Cyber cover', kind: 'insurance_renewal' });
  });

  it('deletes only after the inline two-step confirm, never on the first click', async () => {
    const { orgFetch, calls } = fetchFor([keyDate()]);
    const windowConfirm = vi.spyOn(window, 'confirm');
    render(<OrgKeyDatesCard orgId={ORG_ID} orgFetch={orgFetch} />);

    await userEvent.click(await screen.findByTestId('key-date-delete-kd-1'));
    // First click arms the confirm; nothing is sent yet.
    expect(calls().some(([, init]) => init?.method === 'DELETE')).toBe(false);
    expect(screen.getByTestId('key-date-row-kd-1')).toBeTruthy();

    await userEvent.click(screen.getByTestId('key-date-delete-confirm-kd-1'));
    await waitFor(() => expect(screen.queryByTestId('key-date-row-kd-1')).toBeNull());
    expect(calls().some(([path, init]) => path === `${BASE}/kd-1` && init?.method === 'DELETE')).toBe(true);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Key date deleted' }));
    expect(windowConfirm).not.toHaveBeenCalled();
    windowConfirm.mockRestore();
  });

  it('lets the armed delete be cancelled', async () => {
    const { orgFetch, calls } = fetchFor([keyDate()]);
    render(<OrgKeyDatesCard orgId={ORG_ID} orgFetch={orgFetch} />);
    await userEvent.click(await screen.findByTestId('key-date-delete-kd-1'));
    await userEvent.click(screen.getByTestId('key-date-delete-cancel-kd-1'));
    expect(screen.queryByTestId('key-date-delete-confirm-kd-1')).toBeNull();
    expect(screen.getByTestId('key-date-delete-kd-1')).toBeTruthy();
    expect(calls().some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });

  it('shows the load-failed copy, not the empty state, when the list request fails', async () => {
    const orgFetch = vi.fn(async () => json({ error: 'boom' }, 500)) as unknown as OrgFetch;
    render(<OrgKeyDatesCard orgId={ORG_ID} orgFetch={orgFetch} />);
    await waitFor(() => expect(screen.getByTestId('org-key-dates').textContent).toContain('Could not load key dates.'));
    expect(screen.getByTestId('org-key-dates').textContent).not.toContain('No key dates recorded.');
  });
});
