import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractDetail from './ContractDetail';
import * as api from '../../lib/api/contracts';
import type { ContractDetail as ContractDetailData, ContractStatus } from '../../lib/api/contracts';

type Perm = { resource: string; action: string };

// Mutable grant set the mocked auth store reads from. Covers the NEGATIVE gating
// branches absent from the rest of the contracts tests. The lifecycle actions
// (pause/resume/cancel) and "Generate invoice now" are the highest-risk controls
// in the contracts surface — they gate on contracts:manage, NOT contracts:write.
// A write-only operator must NOT see them.
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
  return {
    ...actual,
    contractTransition: vi.fn(),
    generateContractInvoice: vi.fn(),
    getContractEstimate: vi.fn(),
  };
});

const resp = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function detail(status: ContractStatus): ContractDetailData {
  return {
    contract: {
      id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status,
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
}

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [];
  (api.getContractEstimate as any).mockResolvedValue(resp({ data: { currencyCode: 'USD', periodTotal: '500.00', lines: [] } }));
});

describe('ContractDetail — permission gating', () => {
  it('contracts:write WITHOUT contracts:manage hides the lifecycle actions on an active contract', async () => {
    // Active contract offers pause + cancel — both manage-gated. write alone must
    // not surface them, and must not surface "Generate invoice now".
    state.permissions = [{ resource: 'contracts', action: 'write' }];
    render(<ContractDetail detail={detail('active')} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-detail')).toBeInTheDocument());

    expect(screen.queryByTestId('contract-lifecycle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('contract-pause-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('contract-cancel-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('generate-now-btn')).not.toBeInTheDocument();
  });

  it('read-only (contracts:read) also hides lifecycle + generate', async () => {
    state.permissions = [{ resource: 'contracts', action: 'read' }];
    render(<ContractDetail detail={detail('active')} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-detail')).toBeInTheDocument());

    expect(screen.queryByTestId('contract-lifecycle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('generate-now-btn')).not.toBeInTheDocument();
  });

  it('contracts:manage reveals pause/cancel and Generate invoice now on an active contract', async () => {
    // Positive control proving the gate discriminates.
    state.permissions = [{ resource: 'contracts', action: 'manage' }];
    render(<ContractDetail detail={detail('active')} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-detail')).toBeInTheDocument());

    expect(screen.getByTestId('contract-lifecycle')).toBeInTheDocument();
    expect(screen.getByTestId('contract-pause-btn')).toBeInTheDocument();
    expect(screen.getByTestId('contract-cancel-btn')).toBeInTheDocument();
    expect(screen.getByTestId('generate-now-btn')).toBeInTheDocument();
  });

  it('contracts:manage on a paused contract offers resume/cancel (no generate)', async () => {
    // Paused contracts can resume or cancel; generate is active-only, so even
    // with manage it stays hidden — pins the canGenerate side of the gate.
    state.permissions = [{ resource: 'contracts', action: 'manage' }];
    render(<ContractDetail detail={detail('paused')} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-detail')).toBeInTheDocument());

    expect(screen.getByTestId('contract-resume-btn')).toBeInTheDocument();
    expect(screen.getByTestId('contract-cancel-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-now-btn')).not.toBeInTheDocument();
  });
});
