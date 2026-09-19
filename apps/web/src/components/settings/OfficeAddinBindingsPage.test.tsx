import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), runAction: vi.fn(), handleActionError: vi.fn(), navigateTo: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: mocks.fetchWithAuth }));
vi.mock('../../lib/runAction', () => ({ runAction: mocks.runAction, handleActionError: mocks.handleActionError }));
vi.mock('@/lib/navigation', () => ({ navigateTo: mocks.navigateTo }));
// formatDate now routes through the central dateTimeFormat helper, which
// resolves a display locale via lib/i18n/format.ts's resolvedFormattingLocale
// (getFallbackFormattingLocale + the i18n instance) — both named exports must
// be present on the mock or vitest throws on the missing-export access.
vi.mock('@/lib/i18n', () => ({
  default: {},
  i18n: {},
  getFallbackFormattingLocale: () => undefined,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

import OfficeAddinBindingsPage from './OfficeAddinBindingsPage';

const BINDING_ID = '44444444-4444-4444-8444-444444444444';

function response(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function bindingListResponse() {
  return response({
    bindings: [
      {
        id: BINDING_ID,
        userId: 'user-1',
        userName: 'Tess Tech',
        userEmail: 'tess@msp.example',
        entraTenantId: 'tenant-1',
        mfaVerifiedAt: '2026-01-01T00:00:00Z',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
  });
}

describe('OfficeAddinBindingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchWithAuth.mockResolvedValue(bindingListResponse());
  });

  it('lists active bindings in the table', async () => {
    render(<OfficeAddinBindingsPage />);
    expect(await screen.findByText('Tess Tech')).toBeInTheDocument();
    expect(screen.getByText('tess@msp.example')).toBeInTheDocument();
    expect(screen.getByTestId('office-addin-bindings-table')).toBeInTheDocument();
    expect(screen.getByTestId(`revoke-binding-${BINDING_ID}`)).toBeInTheDocument();
  });

  it('shows an empty state when there are no bindings', async () => {
    mocks.fetchWithAuth.mockResolvedValue(response({ bindings: [] }));
    render(<OfficeAddinBindingsPage />);
    expect(await screen.findByText('officeAddinBindings.empty')).toBeInTheDocument();
  });

  it('revokes a binding via runAction after confirming, then refreshes the list', async () => {
    mocks.runAction.mockResolvedValueOnce({ revoked: true });
    render(<OfficeAddinBindingsPage />);
    await screen.findByText('Tess Tech');

    fireEvent.click(screen.getByTestId(`revoke-binding-${BINDING_ID}`));
    expect(await screen.findByTestId('confirm-revoke-binding')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-revoke-binding'));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledTimes(1));

    // fetchWithAuth: initial load, DELETE (wrapped by runAction mock — assert
    // the request builder targets the right URL/method), then the refetch.
    const deleteCall = mocks.runAction.mock.calls[0][0];
    const deleteResponse = deleteCall.request();
    expect(mocks.fetchWithAuth).toHaveBeenCalledWith(
      `/office-addin/bindings/${BINDING_ID}`,
      expect.objectContaining({ method: 'DELETE' })
    );
    await deleteResponse;

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledWith('/office-addin/bindings'));
    expect(screen.queryByTestId('confirm-revoke-binding')).not.toBeInTheDocument();
  });

  it('redirects to login on a 401', async () => {
    mocks.fetchWithAuth.mockResolvedValue(response({ error: 'unauthorized' }, 401));
    render(<OfficeAddinBindingsPage />);
    await waitFor(() => expect(mocks.navigateTo).toHaveBeenCalledWith('/login', { replace: true }));
  });
});
