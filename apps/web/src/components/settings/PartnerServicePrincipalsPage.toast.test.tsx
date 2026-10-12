/**
 * A refused key issue must surface exactly one toast (#8368). Uses the real
 * runAction and handleActionError so the component's catch path and
 * runAction's own toast are both exercised.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  showToast: vi.fn(),
  ownerId: '66666666-6666-4666-8666-666666666666',
}));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: mocks.fetchWithAuth,
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: mocks.ownerId } }),
}));
vi.mock('../shared/Toast', () => ({ showToast: mocks.showToast }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
// '@/lib/i18n' (the page's side-effect import) and runAction's './i18n' are
// the same module, so one mock serves both.
vi.mock('@/lib/i18n', () => ({ default: {}, i18n: { exists: () => false, t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import PartnerServicePrincipalsPage from './PartnerServicePrincipalsPage';

const PRINCIPAL_ID = '22222222-2222-4222-8222-222222222222';
const REFUSAL = "Only this service principal's owner can issue or rotate its keys, re-enable it, or widen its access";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function openIssueDialog() {
  render(<PartnerServicePrincipalsPage />);
  await screen.findByText('Weavestream');
  fireEvent.click(screen.getByTestId(`issue-key-${PRINCIPAL_ID}`));
  fireEvent.change(screen.getByLabelText('partnerServicePrincipals.keyName'), { target: { value: 'k' } });
}

// Let any trailing catch handler run before counting toasts.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PartnerServicePrincipalsPage refusal toasts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The server is the source of truth: even a caller the page believes is
    // the owner can be refused (e.g. the owner lost a scope it carries).
    mocks.fetchWithAuth.mockImplementation(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({ error: REFUSAL, code: 'SERVICE_PRINCIPAL_OWNER_REQUIRED' }, 403);
      }
      return jsonResponse({ data: [{
        id: PRINCIPAL_ID, name: 'Weavestream', description: null, status: 'active', scopes: ['devices:read'],
        expiresAt: null, sourceCidrs: [], owner: { id: mocks.ownerId, name: 'Pat Owner' }, keys: [],
      }] });
    });
  });

  it('toasts a 403 issue refusal once', async () => {
    await openIssueDialog();
    fireEvent.click(screen.getByTestId('confirm-issue-key'));

    await waitFor(() => expect(mocks.showToast).toHaveBeenCalled());
    await settle();
    expect(mocks.showToast).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: REFUSAL }));
  });

  it('sends one request and toasts once when Issue is double-clicked against a refusal', async () => {
    await openIssueDialog();
    fireEvent.click(screen.getByTestId('confirm-issue-key'));
    fireEvent.click(screen.getByTestId('confirm-issue-key'));

    await waitFor(() => expect(mocks.showToast).toHaveBeenCalled());
    await settle();
    expect(mocks.fetchWithAuth.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(mocks.showToast).toHaveBeenCalledTimes(1);
  });
});
