import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractEditor from './ContractEditor';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import * as api from '../../lib/api/contracts';
import type { ContractDetail } from '../../lib/api/contracts';

// Wildcard-admin grants so every gated control renders (mirrors ContractEditor.test.tsx).
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
vi.mock('../catalog/CatalogItemPicker', () => ({ default: () => null }));
vi.mock('../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) }),
}));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return {
    ...actual,
    createContract: vi.fn(),
    updateContract: vi.fn(),
    addContractLine: vi.fn(),
    removeContractLine: vi.fn(),
    contractTransition: vi.fn(),
    getContractEstimate: vi.fn(),
  };
});

const fetchMock = vi.mocked(fetchWithAuth);
const resp = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const draftDetail: ContractDetail = {
  contract: {
    id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status: 'draft',
    billingTiming: 'advance', intervalMonths: 1, startDate: '2026-06-01', endDate: null,
    nextBillingAt: null, autoIssue: false, autoRenew: false, renewalTermMonths: null, renewalNoticeDays: null,
    currencyCode: 'USD', notes: null, terms: null,
    createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  lines: [
    {
      id: 'cl-1', contractId: 'ct-1', orgId: 'org-1', lineType: 'flat', description: 'Managed services',
      catalogItemId: null, unitPrice: '500.00', manualQuantity: null, siteId: null, taxable: false,
      sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    },
  ],
  periods: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
    if (url.startsWith('/orgs/sites')) return resp({ data: [] });
    return resp({ data: {} });
  });
  (api.getContractEstimate as any).mockResolvedValue(resp({ data: { currencyCode: 'USD', periodTotal: '500.00', lines: [] } }));
  (api.updateContract as any).mockResolvedValue(resp({ data: {} }));
  (api.removeContractLine as any).mockResolvedValue(resp({ data: { ok: true } }));
});

describe('ContractEditor — blur autosave (existing contract)', () => {
  it('PATCHes the contract with the new name on blur', async () => {
    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    const nameInput = await screen.findByTestId('contract-form-name');

    fireEvent.change(nameInput, { target: { value: 'Acme MSA v2' } });
    fireEvent.blur(nameInput);

    await waitFor(() => expect(api.updateContract).toHaveBeenCalled());
    expect((api.updateContract as any).mock.calls[0][1]).toMatchObject({ name: 'Acme MSA v2' });
  });

  it('does NOT show a whole-form Save button for an existing contract', async () => {
    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    await screen.findByTestId('contract-form-name');
    expect(screen.queryByTestId('save-contract-btn')).not.toBeInTheDocument();
  });

  it('announces "Saved" via the SR live region after a successful save', async () => {
    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    const nameInput = await screen.findByTestId('contract-form-name');
    fireEvent.change(nameInput, { target: { value: 'Renamed' } });
    fireEvent.blur(nameInput);

    await waitFor(() => expect(screen.getByTestId('contract-field-saved')).toHaveTextContent('Saved'));
  });

  it('saves billing timing on change (select commits without blur)', async () => {
    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    fireEvent.change(await screen.findByTestId('contract-form-timing'), { target: { value: 'arrears' } });

    await waitFor(() => expect(api.updateContract).toHaveBeenCalled());
    expect((api.updateContract as any).mock.calls[0][1]).toEqual({ billingTiming: 'arrears' });
  });

  it('saves auto-issue on change (checkbox commits without blur)', async () => {
    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('contract-form-auto-issue'));

    await waitFor(() => expect(api.updateContract).toHaveBeenCalled());
    expect((api.updateContract as any).mock.calls[0][1]).toEqual({ autoIssue: true });
  });

  it('saves notes on blur, trimming and nulling an emptied value', async () => {
    render(<ContractEditor detail={{ ...draftDetail, contract: { ...draftDetail.contract, notes: 'old note' } }} onChanged={vi.fn()} />);
    const notesInput = await screen.findByTestId('contract-form-notes');
    fireEvent.change(notesInput, { target: { value: '   ' } });
    fireEvent.blur(notesInput);

    await waitFor(() => expect(api.updateContract).toHaveBeenCalled());
    expect((api.updateContract as any).mock.calls[0][1]).toEqual({ notes: null });
  });

  it('does not PATCH when a field blurs unchanged', async () => {
    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    const nameInput = await screen.findByTestId('contract-form-name');
    fireEvent.blur(nameInput);
    const notesInput = screen.getByTestId('contract-form-notes');
    fireEvent.blur(notesInput);

    await new Promise((r) => setTimeout(r, 20));
    expect(api.updateContract).not.toHaveBeenCalled();
  });

  it('clearing the end date PATCHes endDate:null and turns auto-renew off', async () => {
    const withEnd: ContractDetail = {
      ...draftDetail,
      contract: { ...draftDetail.contract, endDate: '2027-06-01', autoRenew: true, renewalTermMonths: 12 },
    };
    render(<ContractEditor detail={withEnd} onChanged={vi.fn()} />);
    const endInput = await screen.findByTestId('contract-form-end');
    fireEvent.change(endInput, { target: { value: '' } });
    fireEvent.blur(endInput);

    await waitFor(() => expect(api.updateContract).toHaveBeenCalled());
    expect((api.updateContract as any).mock.calls[0][1]).toEqual({ endDate: null, autoRenew: false });
  });

  it('defers the auto-renew PATCH until a renewal term is entered', async () => {
    // autoRenew:true without a term 400s server-side, so checking the box only
    // reveals the fields; the term's blur commit carries autoRenew:true.
    const withEnd: ContractDetail = {
      ...draftDetail,
      contract: { ...draftDetail.contract, endDate: '2027-06-01' },
    };
    render(<ContractEditor detail={withEnd} onChanged={vi.fn()} />);
    const toggle = await screen.findByTestId('contract-auto-renew-toggle');
    fireEvent.click(toggle.querySelector('input')!);

    await new Promise((r) => setTimeout(r, 20));
    expect(api.updateContract).not.toHaveBeenCalled();

    const term = await screen.findByTestId('contract-renewal-term');
    fireEvent.change(term, { target: { value: '12' } });
    fireEvent.blur(term);

    await waitFor(() => expect(api.updateContract).toHaveBeenCalled());
    expect((api.updateContract as any).mock.calls[0][1]).toEqual({ autoRenew: true, renewalTermMonths: 12 });
  });

  it('unchecking auto-renew PATCHes autoRenew:false immediately', async () => {
    const renewing: ContractDetail = {
      ...draftDetail,
      contract: { ...draftDetail.contract, endDate: '2027-06-01', autoRenew: true, renewalTermMonths: 12 },
    };
    render(<ContractEditor detail={renewing} onChanged={vi.fn()} />);
    const toggle = await screen.findByTestId('contract-auto-renew-toggle');
    fireEvent.click(toggle.querySelector('input')!);

    await waitFor(() => expect(api.updateContract).toHaveBeenCalled());
    expect((api.updateContract as any).mock.calls[0][1]).toEqual({ autoRenew: false });
  });

  it('locks schedule fields (timing, cadence, start) on a non-draft contract', async () => {
    const active: ContractDetail = { ...draftDetail, contract: { ...draftDetail.contract, status: 'active' } };
    render(<ContractEditor detail={active} onChanged={vi.fn()} />);
    await screen.findByTestId('contract-form-name');

    // Schedule fields drive next_billing_at — the API 409s these on a non-draft,
    // so the editor renders them disabled instead of offering a doomed save.
    expect(screen.getByTestId('contract-form-timing')).toBeDisabled();
    expect(screen.getByTestId('contract-form-interval')).toBeDisabled();
    expect(screen.getByTestId('contract-form-start')).toBeDisabled();
    // Non-schedule fields stay editable.
    expect(screen.getByTestId('contract-form-name')).not.toBeDisabled();
    expect(screen.getByTestId('contract-form-notes')).not.toBeDisabled();
  });

  it('shows the org as read-only text (no org select) on an existing contract', async () => {
    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    await screen.findByTestId('contract-form-name');
    expect(screen.queryByTestId('contract-form-org')).not.toBeInTheDocument();
    expect(await screen.findByTestId('contract-form-org-readonly')).toHaveTextContent('Acme');
  });

  it('shows an inline error when the custom interval is emptied, and does not PATCH', async () => {
    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    const cadence = await screen.findByTestId('contract-form-interval');
    fireEvent.change(cadence, { target: { value: 'custom' } });

    const custom = await screen.findByTestId('contract-form-interval-custom');
    fireEvent.change(custom, { target: { value: '' } });
    fireEvent.blur(custom);

    expect(await screen.findByTestId('contract-interval-error')).toHaveTextContent('Enter the number of months');
    expect(api.updateContract).not.toHaveBeenCalled();
  });
});

describe('ContractEditor — failed PATCH rolls optimistic controls back', () => {
  // Immediate-commit controls (selects/checkboxes) have no amber dirty ring, so
  // a rejected save must revert the optimistic local flip AND toast the error —
  // never keep displaying unpersisted state.
  beforeEach(() => {
    (api.updateContract as any).mockResolvedValue(resp({ error: 'nope' }, false));
  });

  it('reverts the auto-issue checkbox and toasts on failure', async () => {
    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    const box = await screen.findByTestId('contract-form-auto-issue');
    fireEvent.click(box);
    expect(box).toBeChecked(); // optimistic

    await waitFor(() => expect(api.updateContract).toHaveBeenCalled());
    await waitFor(() => expect(box).not.toBeChecked());
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('reverts the billing-timing select on failure', async () => {
    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    const sel = await screen.findByTestId('contract-form-timing');
    fireEvent.change(sel, { target: { value: 'arrears' } });

    await waitFor(() => expect(api.updateContract).toHaveBeenCalled());
    await waitFor(() => expect(sel).toHaveValue('advance'));
  });

  it('reverts the cadence preset select on failure', async () => {
    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    const sel = await screen.findByTestId('contract-form-interval');
    fireEvent.change(sel, { target: { value: '3' } });

    await waitFor(() => expect(api.updateContract).toHaveBeenCalled());
    await waitFor(() => expect(sel).toHaveValue('1'));
  });

  it('reverts the auto-renew checkbox when unchecking fails', async () => {
    const renewing: ContractDetail = {
      ...draftDetail,
      contract: { ...draftDetail.contract, endDate: '2027-06-01', autoRenew: true, renewalTermMonths: 12 },
    };
    render(<ContractEditor detail={renewing} onChanged={vi.fn()} />);
    const box = (await screen.findByTestId('contract-auto-renew-toggle')).querySelector('input')!;
    fireEvent.click(box);
    expect(box).not.toBeChecked(); // optimistic

    await waitFor(() => expect(api.updateContract).toHaveBeenCalled());
    await waitFor(() => expect(box).toBeChecked());
  });

  it('reverts the deferred auto-renew flip when the term commit fails', async () => {
    const withEnd: ContractDetail = {
      ...draftDetail,
      contract: { ...draftDetail.contract, endDate: '2027-06-01' },
    };
    render(<ContractEditor detail={withEnd} onChanged={vi.fn()} />);
    const box = (await screen.findByTestId('contract-auto-renew-toggle')).querySelector('input')!;
    fireEvent.click(box); // reveals fields, no PATCH yet
    const term = await screen.findByTestId('contract-renewal-term');
    fireEvent.change(term, { target: { value: '12' } });
    fireEvent.blur(term);

    await waitFor(() => expect(api.updateContract).toHaveBeenCalled());
    // The combined { autoRenew: true, renewalTermMonths } PATCH failed — the
    // toggle must not keep showing "on" for a contract the server left "off".
    await waitFor(() => expect(box).not.toBeChecked());
  });

  it('resyncs the cascaded auto-renew flip when clearing the end date fails', async () => {
    const renewing: ContractDetail = {
      ...draftDetail,
      contract: { ...draftDetail.contract, endDate: '2027-06-01', autoRenew: true, renewalTermMonths: 12 },
    };
    render(<ContractEditor detail={renewing} onChanged={vi.fn()} />);
    const endInput = await screen.findByTestId('contract-form-end');
    const box = screen.getByTestId('contract-auto-renew-toggle').querySelector('input')!;
    fireEvent.change(endInput, { target: { value: '' } });
    expect(box).not.toBeChecked(); // cascaded optimistic flip
    fireEvent.blur(endInput);

    await waitFor(() => expect(api.updateContract).toHaveBeenCalled());
    // endDate keeps its amber ring for retry; the ringless checkbox resyncs.
    await waitFor(() => expect(box).toBeChecked());
  });
});

describe('ContractEditor — immediate-commit controls lock while their PATCH is in flight', () => {
  // Without the lock, a rapid second toggle would capture the OPTIMISTIC value
  // as `prev`, get guard-blocked by runScoped's inFlight set (which resolves
  // false, same as a failure), and revert to the unconfirmed value — silently
  // dropping the second action. Disabling during the window makes that
  // physically impossible.
  it('disables the auto-issue checkbox until the PATCH settles', async () => {
    let resolvePatch!: (v: Response) => void;
    (api.updateContract as any).mockReturnValue(new Promise<Response>((r) => { resolvePatch = r; }));

    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    const box = await screen.findByTestId('contract-form-auto-issue');
    fireEvent.click(box);

    await waitFor(() => expect(box).toBeDisabled());
    resolvePatch(resp({ data: {} }));
    await waitFor(() => expect(box).not.toBeDisabled());
    expect(box).toBeChecked(); // success — the optimistic value stands
  });

  it('disables the auto-renew checkbox until its PATCH settles', async () => {
    // Same lock as auto-issue, on the renew toggle's own 'autoRenew' pending key:
    // a rapid re-toggle mid-flight would otherwise capture the optimistic value
    // as `prev` and silently drop the second action.
    let resolvePatch!: (v: Response) => void;
    (api.updateContract as any).mockReturnValue(new Promise<Response>((r) => { resolvePatch = r; }));

    const renewing: ContractDetail = {
      ...draftDetail,
      contract: { ...draftDetail.contract, endDate: '2027-06-01', autoRenew: true, renewalTermMonths: 12 },
    };
    render(<ContractEditor detail={renewing} onChanged={vi.fn()} />);
    const box = (await screen.findByTestId('contract-auto-renew-toggle')).querySelector('input')!;
    fireEvent.click(box); // uncheck → immediate autoRenew:false PATCH

    await waitFor(() => expect(box).toBeDisabled());
    resolvePatch(resp({ data: {} }));
    await waitFor(() => expect(box).not.toBeDisabled());
    expect(box).not.toBeChecked(); // success — the optimistic uncheck stands
  });

  it('disables the billing-timing select until the PATCH settles', async () => {
    let resolvePatch!: (v: Response) => void;
    (api.updateContract as any).mockReturnValue(new Promise<Response>((r) => { resolvePatch = r; }));

    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    const sel = await screen.findByTestId('contract-form-timing');
    fireEvent.change(sel, { target: { value: 'arrears' } });

    await waitFor(() => expect(sel).toBeDisabled());
    resolvePatch(resp({ data: {} }));
    await waitFor(() => expect(sel).not.toBeDisabled());
    expect(sel).toHaveValue('arrears');
  });

  it("shared 'interval' key: a custom-interval blur locks the preset select too", async () => {
    let resolvePatch!: (v: Response) => void;
    (api.updateContract as any).mockReturnValue(new Promise<Response>((r) => { resolvePatch = r; }));

    // intervalMonths 5 → custom mode on mount.
    const custom5: ContractDetail = { ...draftDetail, contract: { ...draftDetail.contract, intervalMonths: 5 } };
    render(<ContractEditor detail={custom5} onChanged={vi.fn()} />);
    const customInput = await screen.findByTestId('contract-form-interval-custom');
    const presetSel = screen.getByTestId('contract-form-interval');
    fireEvent.change(customInput, { target: { value: '6' } });
    fireEvent.blur(customInput);

    // Both controls share the 'interval' pending key: a preset click right
    // after a custom blur must not race the in-flight custom commit.
    await waitFor(() => expect(customInput).toBeDisabled());
    expect(presetSel).toBeDisabled();
    resolvePatch(resp({ data: {} }));
    await waitFor(() => expect(customInput).not.toBeDisabled());
    expect(presetSel).not.toBeDisabled();
  });
});

describe('ContractEditor — remove line confirm', () => {
  it('opens a confirm naming the line; Cancel keeps the line', async () => {
    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    const removeBtn = await screen.findByTestId('line-remove-0');
    fireEvent.click(removeBtn);

    // Confirm dialog names the line ("Managed services" alone also matches the
    // table cell, so assert on the dialog's full sentence).
    expect(await screen.findByText(/This removes "Managed services" from the contract/)).toBeInTheDocument();
    // Cancel: no delete call, line still present.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('contract-line-remove-confirm')).not.toBeInTheDocument());
    expect(api.removeContractLine).not.toHaveBeenCalled();
    expect(screen.getByTestId('line-remove-0')).toBeInTheDocument();
  });

  it('confirming removes the line', async () => {
    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('line-remove-0'));
    fireEvent.click(await screen.findByTestId('contract-line-remove-confirm'));

    await waitFor(() => expect(api.removeContractLine).toHaveBeenCalledWith('ct-1', 'cl-1'));
  });
});
