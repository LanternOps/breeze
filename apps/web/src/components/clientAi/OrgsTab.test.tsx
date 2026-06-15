import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OrgsTab from './OrgsTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const ORG_A = '0c0c0c0c-1111-4222-8333-444455556666'; // not provisioned (with suggestion)
const ORG_B = '1d1d1d1d-1111-4222-8333-444455556666'; // consent pending
const ORG_C = '2e2e2e2e-1111-4222-8333-444455556666'; // active
const TID = '6f4f4f4f-1111-4222-8333-444455556666';

const baseRow = {
  mapped: false,
  entraTenantId: null as string | null,
  suggestedEntraTenantId: null as string | null,
  consentStatus: 'unknown' as 'unknown' | 'pending' | 'granted',
  policyEnabled: false,
  currentMonthCostCents: 0,
  currentMonthMessages: 0,
};

const ROWS = [
  { ...baseRow, orgId: ORG_A, orgName: 'Unprovisioned Org', suggestedEntraTenantId: TID },
  { ...baseRow, orgId: ORG_B, orgName: 'Pending Org', mapped: true, entraTenantId: TID, consentStatus: 'pending' as const },
  {
    ...baseRow,
    orgId: ORG_C,
    orgName: 'Active Org',
    mapped: true,
    entraTenantId: TID,
    consentStatus: 'granted' as const,
    policyEnabled: true,
    currentMonthCostCents: 1234,
    currentMonthMessages: 87,
  },
];

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

function mockApi() {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/client-ai/admin/orgs' && !init?.method) {
      return makeJsonResponse({ data: ROWS });
    }
    if (url === `/client-ai/admin/orgs/${ORG_A}/tenant-mapping` && init?.method === 'PUT') {
      return makeJsonResponse({
        mapping: { id: 'm1', orgId: ORG_A, entraTenantId: TID, createdAt: '', updatedAt: '' },
      });
    }
    if (url === `/client-ai/admin/orgs/${ORG_A}/consent-url` && !init?.method) {
      return makeJsonResponse({
        url: `https://login.microsoftonline.com/${TID}/adminconsent?client_id=x`,
        tenantSegment: TID,
        redirectUri: 'https://breeze.example/api/v1/client-ai/consent/callback',
      });
    }
    if (url === `/client-ai/admin/orgs/${ORG_C}/tenant-mapping` && init?.method === 'DELETE') {
      return makeJsonResponse({ mapping: null });
    }
    return makeJsonResponse({ error: 'unexpected' }, false, 500);
  });
}

describe('OrgsTab', () => {
  const onOpenPolicy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the three onboarding status chips', async () => {
    mockApi();
    render(<OrgsTab onOpenPolicy={onOpenPolicy} />);
    await waitFor(() => expect(screen.getByTestId('ai-office-status-unprovisioned')).toBeInTheDocument());
    expect(screen.getByTestId('ai-office-status-pending')).toBeInTheDocument();
    expect(screen.getByTestId('ai-office-status-active')).toBeInTheDocument();
    expect(screen.getByText('$12.34')).toBeInTheDocument(); // 1234 cents MTD
  });

  it('wizard step 1 pre-fills the suggested tenant and PUTs the exact mapping payload', async () => {
    mockApi();
    render(<OrgsTab onOpenPolicy={onOpenPolicy} />);
    await waitFor(() => expect(screen.getByTestId(`ai-office-wizard-open-${ORG_A}`)).toBeInTheDocument());

    fireEvent.click(screen.getByTestId(`ai-office-wizard-open-${ORG_A}`));
    const input = screen.getByTestId('ai-office-wizard-tenant-input') as HTMLInputElement;
    expect(input.value).toBe(TID); // pre-filled from suggestedEntraTenantId (M365 reuse audit)

    fireEvent.click(screen.getByTestId('ai-office-wizard-save-mapping'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    );
    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(String(putCall![0])).toBe(`/client-ai/admin/orgs/${ORG_A}/tenant-mapping`);
    expect(JSON.parse(String(putCall![1]!.body))).toEqual({ entraTenantId: TID });

    // Advances to step 2 and loads the consent URL
    await waitFor(() => expect(screen.getByTestId('ai-office-wizard-step-2')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('ai-office-consent-url')).toBeInTheDocument());
  });

  it('unmap requires confirmation and DELETEs the mapping', async () => {
    mockApi();
    render(<OrgsTab onOpenPolicy={onOpenPolicy} />);
    await waitFor(() => expect(screen.getByTestId(`ai-office-unmap-${ORG_C}`)).toBeInTheDocument());

    fireEvent.click(screen.getByTestId(`ai-office-unmap-${ORG_C}`));
    fireEvent.click(screen.getByTestId('ai-office-unmap-confirm'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
    );
    const delCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(String(delCall![0])).toBe(`/client-ai/admin/orgs/${ORG_C}/tenant-mapping`);
  });

  it('shows the not-enabled notice when the admin group is dark-gated (404)', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'Breeze AI for Office is not enabled' }, false, 404));
    render(<OrgsTab onOpenPolicy={onOpenPolicy} />);
    await waitFor(() => expect(screen.getByTestId('ai-office-not-enabled')).toBeInTheDocument());
  });

  it('Policy button hands the orgId to onOpenPolicy', async () => {
    mockApi();
    render(<OrgsTab onOpenPolicy={onOpenPolicy} />);
    await waitFor(() => expect(screen.getByTestId(`ai-office-policy-open-${ORG_C}`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId(`ai-office-policy-open-${ORG_C}`));
    expect(onOpenPolicy).toHaveBeenCalledWith(ORG_C);
  });
});
