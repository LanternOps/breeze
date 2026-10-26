import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractWorkspace from './ContractWorkspace';
import type { ContractDetail as ContractDetailData } from '../../lib/api/contracts';

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
vi.mock('./ContractEditor', () => ({ default: () => <div /> }));
vi.mock('./ContractDetail', () => ({ default: () => <div /> }));
vi.mock('../agreements/RecordSignedAgreementDialog', () => ({ default: () => null }));
vi.mock('../agreements/SendAgreementDialog', () => ({
  default: (p: { open: boolean; lockedOrgId?: string; lockedContractId?: string; onSent: () => void }) =>
    p.open ? (
      <div data-testid="agreements-send-dialog" data-org={p.lockedOrgId} data-contract={p.lockedContractId}>
        <button type="button" data-testid="stub-sent" onClick={p.onSent} />
      </div>
    ) : null,
}));

vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return { ...actual, getContract: vi.fn() };
});
vi.mock('../../lib/api/contractDocuments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contractDocuments')>();
  return { ...actual, listContractDocuments: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }) };
});

import { getContract } from '../../lib/api/contracts';

beforeEach(() => {
  state.permissions = [];
  vi.clearAllMocks();
  const detail = { contract: { id: 'c1', orgId: 'org-9', name: 'Acme Retainer', status: 'active' }, lines: [] } as unknown as ContractDetailData;
  vi.mocked(getContract).mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: detail }) } as Response);
});

describe('ContractWorkspace Send for signature (#9075 W2c)', () => {
  it('shows the button only with agreements:send AND agreements:write', async () => {
    state.permissions = [{ resource: 'agreements', action: 'send' }];
    const { unmount } = render(<ContractWorkspace contractId="c1" />);
    await screen.findByTestId('contract-workspace-title');
    expect(screen.queryByTestId('contract-send-agreement-open')).toBeNull();
    unmount();

    state.permissions = [{ resource: 'agreements', action: 'send' }, { resource: 'agreements', action: 'write' }];
    render(<ContractWorkspace contractId="c1" />);
    expect(await screen.findByTestId('contract-send-agreement-open')).toBeInTheDocument();
  });

  it('opens the dialog locked to this contract and org, and closes + reloads on sent', async () => {
    state.permissions = [{ resource: 'agreements', action: 'send' }, { resource: 'agreements', action: 'write' }];
    render(<ContractWorkspace contractId="c1" />);
    fireEvent.click(await screen.findByTestId('contract-send-agreement-open'));
    const dialog = await screen.findByTestId('agreements-send-dialog');
    expect(dialog).toHaveAttribute('data-org', 'org-9');
    expect(dialog).toHaveAttribute('data-contract', 'c1');
    const before = vi.mocked(getContract).mock.calls.length;
    fireEvent.click(screen.getByTestId('stub-sent'));
    expect(screen.queryByTestId('agreements-send-dialog')).toBeNull();
    await vi.waitFor(() => expect(vi.mocked(getContract).mock.calls.length).toBeGreaterThan(before));
  });
});
