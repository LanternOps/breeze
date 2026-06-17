import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractWorkspace from './ContractWorkspace';
import type { ContractDetail as ContractDetailData } from '../../lib/api/contracts';

type Perm = { resource: string; action: string };

// Mutable grant set the mocked auth store reads from. Guards the NEGATIVE gating
// that an in-browser e2e sweep caught: a read-only billing-viewer (contracts:read
// only) must NOT see the "Edit" affordance on an active contract, and must NOT be
// dropped into the editor on a draft. The server 403s the write either way; this
// hides the write-control. See ContractWorkspace.showEditor / contract-edit-toggle.
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
// Identifiable markers so we can assert which sub-view rendered.
vi.mock('./ContractEditor', () => ({ default: () => <div data-testid="mock-contract-editor" /> }));
vi.mock('./ContractDetail', () => ({ default: () => <div data-testid="mock-contract-detail" /> }));

vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return { ...actual, getContract: vi.fn() };
});

import { getContract } from '../../lib/api/contracts';

function mockContract(status: 'active' | 'draft'): void {
  const detail = {
    contract: { id: 'c1', name: 'Acme Retainer', status },
    lines: [],
  } as unknown as ContractDetailData;
  vi.mocked(getContract).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: detail }),
  } as Response);
}

describe('ContractWorkspace permission gating', () => {
  beforeEach(() => {
    state.permissions = [];
    vi.clearAllMocks();
  });

  it('hides the Edit toggle on an active contract for a read-only viewer', async () => {
    state.permissions = [{ resource: 'contracts', action: 'read' }];
    mockContract('active');
    render(<ContractWorkspace contractId="c1" />);
    await screen.findByTestId('contract-workspace-title');
    expect(screen.queryByTestId('contract-edit-toggle')).toBeNull();
    expect(screen.queryByTestId('mock-contract-editor')).toBeNull();
    expect(screen.getByTestId('mock-contract-detail')).toBeInTheDocument();
  });

  it('shows the Edit toggle on an active contract for a writer', async () => {
    state.permissions = [{ resource: 'contracts', action: 'write' }];
    mockContract('active');
    render(<ContractWorkspace contractId="c1" />);
    await screen.findByTestId('contract-workspace-title');
    expect(screen.getByTestId('contract-edit-toggle')).toBeInTheDocument();
  });

  it('does not drop a read-only viewer into the editor on a draft contract', async () => {
    state.permissions = [{ resource: 'contracts', action: 'read' }];
    mockContract('draft');
    render(<ContractWorkspace contractId="c1" />);
    await screen.findByTestId('contract-workspace-title');
    expect(screen.queryByTestId('mock-contract-editor')).toBeNull();
    expect(screen.getByTestId('mock-contract-detail')).toBeInTheDocument();
  });

  it('shows the editor for a writer on a draft contract', async () => {
    state.permissions = [{ resource: 'contracts', action: 'write' }];
    mockContract('draft');
    render(<ContractWorkspace contractId="c1" />);
    await waitFor(() => expect(screen.getByTestId('mock-contract-editor')).toBeInTheDocument());
  });
});
