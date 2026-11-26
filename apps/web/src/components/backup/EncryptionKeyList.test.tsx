import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import EncryptionKeyList from './EncryptionKeyList';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('EncryptionKeyList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(makeJsonResponse({ data: [] }));
  });

  it('renders loading state', () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));

    render(<EncryptionKeyList />);

    expect(screen.getByText('Loading encryption keys...')).toBeTruthy();
  });

  it('renders empty state when no keys exist', async () => {
    render(<EncryptionKeyList />);

    await screen.findByText('No encryption keys configured.');
  });

  it('renders alpha banner', async () => {
    render(<EncryptionKeyList />);

    await screen.findByText('Encryption Keys');
    expect(screen.getByText(/Client-side encryption keys are not available yet/i)).toBeTruthy();
  });

  it('shows the error banner, not the empty state, when the list fails to load', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));

    render(<EncryptionKeyList />);

    await screen.findByText('boom');
    expect(screen.getByText('Encryption Keys')).toBeTruthy();
  });

  it('offers no create, rotate or deactivate control', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse({
        data: [
          { id: 'k1', name: 'Legacy key', keyType: 'aes_256', keyHash: 'abc', isActive: true, createdAt: '2026-05-06T00:00:00Z', rotatedAt: null, expiresAt: null },
        ],
      }),
    );

    render(<EncryptionKeyList />);

    await screen.findByText('Legacy key');
    expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /rotate/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /deactivate/i })).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('states that client-side keys are unavailable and backups rely on provider encryption', async () => {
    render(<EncryptionKeyList />);

    await screen.findByText('Encryption Keys');
    expect(screen.getByText(/encrypted at rest by the storage provider/i)).toBeTruthy();
  });

  it('lists existing keys read-only using the fields the API returns', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse({
        data: [
          { id: 'k1', name: 'Legacy key', keyType: 'aes_256', keyHash: 'abc', isActive: true, createdAt: '2026-05-06T00:00:00Z', rotatedAt: null, expiresAt: null },
        ],
      }),
    );

    render(<EncryptionKeyList />);

    const row = (await screen.findByText('Legacy key')).closest('tr') as HTMLElement;
    expect(within(row).getByText('AES-256')).toBeTruthy();
    expect(within(row).getByText('Active')).toBeTruthy();
  });

  it('renders rsa, inactive and unknown key types, and only ever issues a GET', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse({
        data: [
          { id: 'k1', name: 'Rsa key', keyType: 'rsa_2048', isActive: false, createdAt: '2026-05-06T00:00:00Z' },
          { id: 'k2', name: 'Odd key', keyType: 'chacha20', isActive: true, createdAt: '2026-05-06T00:00:00Z' },
        ],
      }),
    );

    render(<EncryptionKeyList />);

    const rsa = (await screen.findByText('Rsa key')).closest('tr') as HTMLElement;
    expect(within(rsa).getByText('RSA-2048')).toBeTruthy();
    expect(within(rsa).getByText('Inactive')).toBeTruthy();
    const odd = screen.getByText('Odd key').closest('tr') as HTMLElement;
    expect(within(odd).getByText('chacha20')).toBeTruthy();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe('/backup/encryption/keys');
      expect((call[1] as RequestInit | undefined)?.method ?? 'GET').toBe('GET');
    }
  });
});
