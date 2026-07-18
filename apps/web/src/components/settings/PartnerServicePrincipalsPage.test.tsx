import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), runAction: vi.fn(), handleActionError: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: mocks.fetchWithAuth }));
vi.mock('../../lib/runAction', () => ({ runAction: mocks.runAction, handleActionError: mocks.handleActionError }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/i18n', () => ({ default: {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import PartnerServicePrincipalsPage from './PartnerServicePrincipalsPage';

const PRINCIPAL_ID = '22222222-2222-4222-8222-222222222222';
const KEY_ID = '33333333-3333-4333-8333-333333333333';

function response(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function principalListResponse() {
  return response({ data: [{
    id: PRINCIPAL_ID,
    name: 'Weavestream', description: null, status: 'active', scopes: ['devices:read'],
    expiresAt: null, sourceCidrs: [],
    keys: [{ id: KEY_ID, name: 'Production', keyPrefix: 'brz_sp_abc123', status: 'active', expiresAt: null, rateLimit: 600 }],
  }] });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('PartnerServicePrincipalsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchWithAuth.mockResolvedValue(principalListResponse());
  });

  it('lists only masked prefixes', async () => {
    render(<PartnerServicePrincipalsPage />);
    expect(await screen.findByText('Weavestream')).toBeInTheDocument();
    expect(screen.getByText('brz_sp_abc123…')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('keyHash');
  });

  it('uses runAction for issuing, rotating, revoking, and disabling', async () => {
    mocks.runAction.mockResolvedValueOnce({ key: 'brz_sp_ONETIME', keyId: KEY_ID, keyPrefix: 'brz_sp_ONE' });
    render(<PartnerServicePrincipalsPage />);
    await screen.findByText('Weavestream');

    fireEvent.click(screen.getByTestId(`issue-key-${PRINCIPAL_ID}`));
    fireEvent.change(screen.getByLabelText('partnerServicePrincipals.keyName'), { target: { value: 'Secondary' } });
    fireEvent.click(screen.getByTestId('confirm-issue-key'));
    expect(await screen.findByText('brz_sp_ONETIME')).toBeInTheDocument();
    expect(mocks.runAction).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('close-key-reveal'));
    expect(screen.queryByText('brz_sp_ONETIME')).not.toBeInTheDocument();

    mocks.runAction.mockResolvedValue({ key: 'brz_sp_ROTATED', keyId: KEY_ID, keyPrefix: 'brz_sp_ROT' });
    fireEvent.click(screen.getByTestId(`rotate-key-${KEY_ID}`));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('brz_sp_ROTATED')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('close-key-reveal'));

    fireEvent.click(screen.getByTestId(`revoke-key-${KEY_ID}`));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByTestId(`disable-principal-${PRINCIPAL_ID}`));
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalledTimes(4));
  });

  it('reveals an issued plaintext key immediately while list refresh is pending', async () => {
    const refresh = deferred<Response>();
    mocks.fetchWithAuth
      .mockResolvedValueOnce(principalListResponse())
      .mockReturnValueOnce(refresh.promise);
    mocks.runAction.mockResolvedValueOnce({ key: 'brz_sp_ISSUED_ONCE', keyId: KEY_ID, keyPrefix: 'brz_sp_ISS' });
    const localStore = vi.spyOn(Storage.prototype, 'setItem');

    render(<PartnerServicePrincipalsPage />);
    await screen.findByText('Weavestream');
    fireEvent.click(screen.getByTestId(`issue-key-${PRINCIPAL_ID}`));
    fireEvent.change(screen.getByLabelText('partnerServicePrincipals.keyName'), { target: { value: 'Secondary' } });
    fireEvent.click(screen.getByTestId('confirm-issue-key'));

    expect(await screen.findByText('brz_sp_ISSUED_ONCE')).toBeInTheDocument();
    expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mocks.fetchWithAuth.mock.calls)).not.toContain('brz_sp_ISSUED_ONCE');
    expect(localStore).not.toHaveBeenCalled();

    refresh.resolve(principalListResponse());
    fireEvent.click(screen.getByTestId('close-key-reveal'));
    expect(screen.queryByText('brz_sp_ISSUED_ONCE')).not.toBeInTheDocument();
    localStore.mockRestore();
  });

  it('keeps a rotated plaintext key visible when list refresh fails', async () => {
    mocks.fetchWithAuth
      .mockResolvedValueOnce(principalListResponse())
      .mockRejectedValueOnce(new Error('refresh failed'));
    mocks.runAction.mockResolvedValueOnce({ key: 'brz_sp_ROTATED_ONCE', keyId: KEY_ID, keyPrefix: 'brz_sp_ROT' });
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');

    render(<PartnerServicePrincipalsPage />);
    await screen.findByText('Weavestream');
    fireEvent.click(screen.getByTestId(`rotate-key-${KEY_ID}`));

    expect(await screen.findByText('brz_sp_ROTATED_ONCE')).toBeInTheDocument();
    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(mocks.fetchWithAuth.mock.calls)).not.toContain('brz_sp_ROTATED_ONCE');
    expect(storageWrite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('close-key-reveal'));
    expect(screen.queryByText('brz_sp_ROTATED_ONCE')).not.toBeInTheDocument();
    storageWrite.mockRestore();
  });
});
