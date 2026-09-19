import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractEditor from './ContractEditor';
import { fetchWithAuth } from '../../stores/auth';
import * as api from '../../lib/api/contracts';
import * as distributors from '../../lib/api/distributors';
import type { ContractDetail } from '../../lib/api/contracts';

// Regression for #5878: usePermissions() (apps/web/src/lib/permissions.ts) hands
// back a brand-new `can` closure on every render — it is not memoized. The three
// distributor-status effects below used to depend on `[can]` directly, so ANY
// re-render (org/site/catalog/estimate loads all resolve asynchronously and set
// state) produced a new `can` identity and re-fired all three GETs, cascading
// into ~40 iterations observed in production. This test does not need to mock
// usePermissions to fabricate instability — the real hook already behaves this
// way; the fix must stop depending on its identity.

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
vi.mock('../../lib/api/distributors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/distributors')>();
  return {
    ...actual,
    ecExpressStatus: vi.fn(),
    pax8Status: vi.fn(),
  };
});

const fetchMock = vi.mocked(fetchWithAuth);
const ecExpressStatusMock = vi.mocked(distributors.ecExpressStatus);
const pax8StatusMock = vi.mocked(distributors.pax8Status);
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
  lines: [],
  periods: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'contracts', action: 'write' }];
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
    if (url.startsWith('/orgs/sites')) return resp({ data: [] });
    if (url.startsWith('/pax8/integration')) return resp({ data: null });
    return resp({ data: {} });
  });
  ecExpressStatusMock.mockResolvedValue(resp({ data: { configured: true, enabled: true } }));
  pax8StatusMock.mockResolvedValue(resp({ data: { configured: false, enabled: false } }));
  (api.getContractEstimate as any).mockResolvedValue(resp({ data: { currencyCode: 'USD', periodTotal: '0.00', lines: [], uncoveredDevices: null, overages: [] } }));
});

describe('ContractEditor — distributor status re-fetch (#5878)', () => {
  it('fetches EC Express / Pax8 status once, not once per re-render', async () => {
    render(<ContractEditor detail={draftDetail} onChanged={vi.fn()} />);

    // Let every async effect on mount (orgs, sites, catalog, estimate, and the
    // three distributor-status checks) settle, including any state-update-driven
    // re-render cascade.
    await waitFor(() => expect(ecExpressStatusMock).toHaveBeenCalled());
    // Give any re-render-triggered re-fire a chance to happen before asserting.
    await new Promise((r) => setTimeout(r, 50));

    expect(ecExpressStatusMock).toHaveBeenCalledTimes(1);
    expect(pax8StatusMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/pax8/integration'))).toHaveLength(1);
  });
});
