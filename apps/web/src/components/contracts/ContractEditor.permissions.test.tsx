import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractEditor from './ContractEditor';
import { fetchWithAuth } from '../../stores/auth';
import * as api from '../../lib/api/contracts';
import type { ContractDetail } from '../../lib/api/contracts';

type Perm = { resource: string; action: string };

// Mutable grant set the mocked auth store reads from. Covers the NEGATIVE gating
// branches the wildcard-positive sibling (ContractEditor.test.tsx) never touches.
// The editor separates contracts:write (create/edit headers + lines) from
// contracts:manage (activate, a lifecycle action). A write-only operator must be
// able to build a draft contract but NOT activate it.
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
  state.permissions = [];
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
    if (url.startsWith('/orgs/sites')) return resp({ data: [] });
    return resp({ data: {} });
  });
  (api.getContractEstimate as any).mockResolvedValue(resp({ data: { currencyCode: 'USD', periodTotal: '500.00', lines: [] } }));
});

describe('ContractEditor — permission gating', () => {
  it('read-only (contracts:read) hides create/save, add-line and per-line remove', async () => {
    state.permissions = [{ resource: 'contracts', action: 'read' }];
    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-editor')).toBeInTheDocument());

    expect(screen.queryByTestId('save-contract-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('add-line-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('line-remove-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('activate-contract-btn')).not.toBeInTheDocument();
  });

  it('contracts:write WITHOUT contracts:manage shows edit controls but NOT Activate', async () => {
    // The security-relevant distinction: write builds/edits the draft; activating
    // (a lifecycle transition) requires contracts:manage.
    state.permissions = [{ resource: 'contracts', action: 'write' }];
    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-editor')).toBeInTheDocument());

    expect(screen.getByTestId('save-contract-btn')).toBeInTheDocument();
    expect(screen.getByTestId('add-line-btn')).toBeInTheDocument();
    expect(screen.getByTestId('line-remove-0')).toBeInTheDocument();
    // manage-gated:
    expect(screen.queryByTestId('activate-contract-btn')).not.toBeInTheDocument();
  });

  it('contracts:manage reveals Activate (positive control)', async () => {
    // Save/add/remove stay hidden without write, proving the gates are
    // independent; Activate appears for a draft contract once manage is granted.
    state.permissions = [{ resource: 'contracts', action: 'manage' }];
    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contract-editor')).toBeInTheDocument());

    expect(screen.getByTestId('activate-contract-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('save-contract-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('add-line-btn')).not.toBeInTheDocument();
  });

  it('create mode: contracts:read hides the Create button', async () => {
    state.permissions = [{ resource: 'contracts', action: 'read' }];
    render(<ContractEditor />);
    await waitFor(() => expect(screen.getByTestId('contract-editor')).toBeInTheDocument());
    expect(screen.queryByTestId('save-contract-btn')).not.toBeInTheDocument();
  });

  it('create mode: contracts:write reveals the Create button', async () => {
    state.permissions = [{ resource: 'contracts', action: 'write' }];
    render(<ContractEditor />);
    await waitFor(() => expect(screen.getByTestId('contract-editor')).toBeInTheDocument());
    expect(screen.getByTestId('save-contract-btn')).toBeInTheDocument();
  });
});
