import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AddDnsPolicyModal from './AddDnsPolicyModal';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

const INTEGRATION_ID = '22222222-2222-2222-2222-222222222222';

function makeJsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status < 300 ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function mockApi(createResponse: Response) {
  fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/dns-security/integrations') {
      return makeJsonResponse({
        data: [{ id: INTEGRATION_ID, name: 'Cloudflare', provider: 'cloudflare' }],
      });
    }
    if (url === '/dns-security/policies' && init?.method === 'POST') {
      return createResponse;
    }
    throw new Error(`unexpected request ${url}`);
  });
}

async function fillAndSubmit() {
  render(<AddDnsPolicyModal onClose={() => {}} onCreated={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText('Integration')).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Policy name'), { target: { value: 'Threat blocklist' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create policy' }));
}

describe('AddDnsPolicyModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts the selected integration and lets the API derive the owning org (#8329)', async () => {
    mockApi(makeJsonResponse({ id: 'policy-1', name: 'Threat blocklist', syncScheduled: true }, 201));

    await fillAndSubmit();

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/dns-security/policies', expect.objectContaining({ method: 'POST' }))
    );
    const postCall = fetchWithAuthMock.mock.calls.find(([url]) => url === '/dns-security/policies')!;
    const sent = JSON.parse(String(postCall[1]!.body));
    expect(sent).toMatchObject({ integrationId: INTEGRATION_ID, name: 'Threat blocklist', type: 'blocklist' });
  });

  it('shows the API error text, not the generic create-failed message, when the create is rejected', async () => {
    const apiMessage = 'orgId does not match the organization that owns this integration';
    mockApi(makeJsonResponse({ error: apiMessage }, 400));

    await fillAndSubmit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(apiMessage);
    expect(alert).not.toHaveTextContent('Failed to create policy');
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: apiMessage }));
  });

  it('falls back to the generic create-failed message when the API gives no error text', async () => {
    mockApi(makeJsonResponse(null, 500));

    await fillAndSubmit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Failed to create policy');
  });
});
