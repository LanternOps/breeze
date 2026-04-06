import { render, screen } from '@testing-library/react';
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
    expect(screen.getByText(/Client-side encryption key management is in early access/i)).toBeTruthy();
  });
});
