import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractDetail from './ContractDetail';
import * as contractsApi from '../../lib/api/contracts';
import { overlappingSibling, relatedDetail, unrelatedSibling } from './relatedContractsFixtures';

// #9303: a quote accept can create a second draft contract next to a hand-built
// one. The page must name the org's other contracts, and Activate must confirm
// when another draft/active/paused contract bills on the same cadence over an
// overlapping term — activating both bills the customer twice.

type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return { ...actual, contractTransition: vi.fn(), getContractEstimate: vi.fn(), adoptDraftContract: vi.fn() };
});

const resp = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'contracts', action: 'manage' }];
  vi.mocked(contractsApi.getContractEstimate).mockResolvedValue(
    resp({ data: { currencyCode: 'USD', periodTotal: '500.00', lines: [], uncoveredDevices: null, overages: [] } }),
  );
  vi.mocked(contractsApi.contractTransition).mockResolvedValue(resp({ data: null }));
});

describe('ContractDetail — related contracts notice (#9303)', () => {
  it('names each other contract with a link, and warns when one overlaps', async () => {
    render(<ContractDetail detail={relatedDetail('draft', [overlappingSibling, unrelatedSibling])} onChanged={vi.fn()} />);
    const notice = await screen.findByTestId('contract-related-notice');
    expect(within(notice).getByTestId('contract-related-link-ct-hand')).toHaveAttribute('href', '/contracts/ct-hand');
    expect(within(notice).getByTestId('contract-related-link-ct-annual')).toHaveAttribute('href', '/contracts/ct-annual');
    expect(notice).toHaveTextContent('Hand-built MSA');
    expect(notice).toHaveTextContent('24 deliverables');
    expect(within(notice).getByTestId('contract-related-overlap-warning')).toBeInTheDocument();
  });

  it('renders no overlap warning when no sibling overlaps', async () => {
    render(<ContractDetail detail={relatedDetail('active', [unrelatedSibling])} onChanged={vi.fn()} />);
    const notice = await screen.findByTestId('contract-related-notice');
    expect(within(notice).queryByTestId('contract-related-overlap-warning')).not.toBeInTheDocument();
  });

  it('says the estimate is unavailable rather than dropping it silently', async () => {
    render(<ContractDetail detail={relatedDetail('draft', [{ ...overlappingSibling, recurringTotal: null }])} onChanged={vi.fn()} />);
    const notice = await screen.findByTestId('contract-related-notice');
    expect(notice).toHaveTextContent('Per-period estimate unavailable');
  });

  it('renders no notice when the org has no other contract', async () => {
    render(<ContractDetail detail={relatedDetail('draft', [])} onChanged={vi.fn()} />);
    await screen.findByTestId('contract-detail');
    expect(screen.queryByTestId('contract-related-notice')).not.toBeInTheDocument();
  });
});

describe('ContractDetail — activate confirm on overlap (#9303)', () => {
  it('opens the overlap confirm instead of activating; Cancel sends nothing', async () => {
    render(<ContractDetail detail={relatedDetail('draft', [overlappingSibling])} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('contract-activate-btn'));

    const dialog = await screen.findByTestId('contract-activate-overlap-confirm');
    expect(dialog).toHaveTextContent('Hand-built MSA');
    expect(contractsApi.contractTransition).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('contract-activate-overlap-confirm')).not.toBeInTheDocument());
    expect(contractsApi.contractTransition).not.toHaveBeenCalled();
  });

  it('lists only the overlapping siblings in the confirm', async () => {
    render(<ContractDetail detail={relatedDetail('draft', [overlappingSibling, unrelatedSibling])} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('contract-activate-btn'));
    const dialog = await screen.findByTestId('contract-activate-overlap-confirm');
    expect(dialog).toHaveTextContent('Hand-built MSA');
    expect(dialog).not.toHaveTextContent('Annual licences');
  });

  it('Confirm sends exactly one activate', async () => {
    render(<ContractDetail detail={relatedDetail('draft', [overlappingSibling])} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('contract-activate-btn'));
    fireEvent.click(await screen.findByTestId('contract-activate-overlap-confirm-btn'));
    await waitFor(() => expect(contractsApi.contractTransition).toHaveBeenCalledTimes(1));
    expect(contractsApi.contractTransition).toHaveBeenCalledWith('ct-1', 'activate');
  });

  it('activates immediately when no sibling overlaps', async () => {
    render(<ContractDetail detail={relatedDetail('draft', [unrelatedSibling])} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('contract-activate-btn'));
    await waitFor(() => expect(contractsApi.contractTransition).toHaveBeenCalledWith('ct-1', 'activate'));
    expect(screen.queryByTestId('contract-activate-overlap-confirm')).not.toBeInTheDocument();
  });
});

// #9346: the quote-created contract can fold a hand-built draft sibling in —
// its deliverables and agreements move here and the draft is deleted.
describe('ContractDetail — adopt a draft sibling (#9346)', () => {
  const activeSibling = { ...overlappingSibling, id: 'ct-live', name: 'Live MSA', status: 'active' as const };

  beforeEach(() => {
    state.permissions = [{ resource: 'contracts', action: 'write' }];
    vi.mocked(contractsApi.adoptDraftContract).mockResolvedValue(resp({ data: {} }));
  });

  it('offers the action only on a DRAFT sibling, to a contracts:write user', async () => {
    render(<ContractDetail detail={relatedDetail('active', [overlappingSibling, activeSibling])} onChanged={vi.fn()} />);
    await screen.findByTestId('contract-related-notice');
    expect(screen.getByTestId('contract-related-adopt-ct-hand')).toBeInTheDocument();
    expect(screen.queryByTestId('contract-related-adopt-ct-live')).not.toBeInTheDocument();
  });

  it('hides the action without contracts:write', async () => {
    state.permissions = [{ resource: 'contracts', action: 'read' }];
    render(<ContractDetail detail={relatedDetail('active', [overlappingSibling])} onChanged={vi.fn()} />);
    await screen.findByTestId('contract-related-notice');
    expect(screen.queryByTestId('contract-related-adopt-ct-hand')).not.toBeInTheDocument();
  });

  it('hides the action when this contract can no longer adopt (paused)', async () => {
    render(<ContractDetail detail={relatedDetail('paused', [overlappingSibling])} onChanged={vi.fn()} />);
    await screen.findByTestId('contract-related-notice');
    expect(screen.queryByTestId('contract-related-adopt-ct-hand')).not.toBeInTheDocument();
  });

  it('confirms first, naming what moves and that the draft is deleted; Cancel sends nothing', async () => {
    render(<ContractDetail detail={relatedDetail('active', [{ ...overlappingSibling, signedAgreementCount: 2 }])} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('contract-related-adopt-ct-hand'));
    const dialog = await screen.findByTestId('contract-adopt-draft-confirm');
    expect(dialog).toHaveTextContent('Hand-built MSA');
    expect(dialog).toHaveTextContent('24 deliverables');
    expect(dialog).toHaveTextContent('2 signed agreements');
    expect(dialog).toHaveTextContent(/deleted/i);
    expect(dialog).toHaveTextContent(/lines are not copied/i);
    expect(contractsApi.adoptDraftContract).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('contract-adopt-draft-confirm')).not.toBeInTheDocument());
    expect(contractsApi.adoptDraftContract).not.toHaveBeenCalled();
  });

  it('Confirm adopts the draft into this contract and refreshes', async () => {
    const onChanged = vi.fn();
    render(<ContractDetail detail={relatedDetail('active', [overlappingSibling])} onChanged={onChanged} />);
    fireEvent.click(await screen.findByTestId('contract-related-adopt-ct-hand'));
    fireEvent.click(await screen.findByTestId('contract-adopt-draft-confirm-btn'));
    await waitFor(() => expect(contractsApi.adoptDraftContract).toHaveBeenCalledTimes(1));
    expect(contractsApi.adoptDraftContract).toHaveBeenCalledWith('ct-1', 'ct-hand');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('contract-adopt-draft-confirm')).not.toBeInTheDocument());
  });

  it('a 409 name collision keeps the dialog open and names the colliding deliverables', async () => {
    const onChanged = vi.fn();
    vi.mocked(contractsApi.adoptDraftContract).mockResolvedValue(resp(
      { error: 'dup', code: 'DUPLICATE_NAME', details: { names: ['Quarterly review', 'Patch report'] } }, false, 409,
    ));
    render(<ContractDetail detail={relatedDetail('active', [overlappingSibling])} onChanged={onChanged} />);
    fireEvent.click(await screen.findByTestId('contract-related-adopt-ct-hand'));
    fireEvent.click(await screen.findByTestId('contract-adopt-draft-confirm-btn'));
    const err = await screen.findByTestId('contract-adopt-draft-collision');
    expect(err).toHaveTextContent('Quarterly review, Patch report');
    expect(screen.getByTestId('contract-adopt-draft-confirm')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
