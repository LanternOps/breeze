import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

const m = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: m.fetchWithAuth }));
vi.mock('../../shared/Toast', () => ({ showToast: m.showToast }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import StorageKeyRevocationCard from './StorageKeyRevocationCard';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const REPLACED = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  configId: 'cfg-1',
  configName: 'Primary',
  bucket: 'backups',
  endpoint: 'storage.example',
  usedBefore: '2026-12-01T00:00:00.000Z',
  replacedAt: '2026-12-02T00:00:00.000Z',
  canCheck: true,
  lastCheckedAt: null,
  lastCheckOutcome: null,
  lastCheckCode: null,
};
const IN_USE = { ...REPLACED, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', configName: 'Archive', replacedAt: null, canCheck: false };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StorageKeyRevocationCard', () => {
  it('renders nothing when no key needs attention', async () => {
    m.fetchWithAuth.mockResolvedValueOnce(json({ data: [] }));
    const { container } = render(<StorageKeyRevocationCard />);
    await waitFor(() => expect(m.fetchWithAuth).toHaveBeenCalledWith('/backup/storage-credentials'));
    expect(container.querySelector('[data-testid="storage-credential-revocation"]')).toBeNull();
  });

  it('lists keys used before the change: replaced keys can be checked, keys in use must be replaced first', async () => {
    m.fetchWithAuth.mockResolvedValueOnce(json({ data: [REPLACED, IN_USE] }));
    render(<StorageKeyRevocationCard />);
    const card = await screen.findByTestId('storage-credential-revocation');
    expect(card.textContent).toMatch(/Replace and disable the storage keys used before/);
    expect(screen.getByText('Primary')).toBeInTheDocument();
    expect(screen.getByText('Archive')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Check old key' })).toHaveLength(1);
    expect(screen.getByText(/Replace the key on the destination first/)).toBeInTheDocument();
  });

  it('checks an old key through runAction and shows what to do when it still works', async () => {
    m.fetchWithAuth
      .mockResolvedValueOnce(json({ data: [REPLACED] }))
      .mockResolvedValueOnce(json({ outcome: 'still_live', message: 'server text' }))
      .mockResolvedValueOnce(json({ data: [{ ...REPLACED, lastCheckOutcome: 'still_live', lastCheckedAt: '2026-12-03T00:00:00.000Z' }] }));
    render(<StorageKeyRevocationCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check old key' }));
    await waitFor(() => expect(m.fetchWithAuth).toHaveBeenCalledWith(
      `/backup/storage-credentials/${REPLACED.id}/check`, { method: 'POST' },
    ));
    expect(await screen.findByText('The previous key still works. Disable it with your storage provider, then check again.'))
      .toBeInTheDocument();
  });

  it('says a key refused for listing may still work for uploads, and keeps both ways to close it', async () => {
    m.fetchWithAuth
      .mockResolvedValueOnce(json({ data: [REPLACED] }))
      .mockResolvedValueOnce(json({ outcome: 'inconclusive', code: 'AccessDenied', message: 'server text' }))
      .mockResolvedValueOnce(json({ data: [{ ...REPLACED, lastCheckOutcome: 'inconclusive', lastCheckCode: 'AccessDenied', lastCheckedAt: '2026-12-03T00:00:00.000Z' }] }));
    render(<StorageKeyRevocationCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check old key' }));
    const text = 'The previous key was refused for listing, but it may still work for uploads. '
      + 'Disable it with your storage provider, then check again, or confirm that you disabled it.';
    await waitFor(() => expect(m.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', message: text })));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check old key' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'I disabled this key' })).toBeInTheDocument();
  });

  it('surfaces a failed check (runAction toasts it)', async () => {
    m.fetchWithAuth
      .mockResolvedValueOnce(json({ data: [REPLACED] }))
      .mockResolvedValueOnce(json({ error: 'Too many key checks for this organization. Try again shortly.' }, 429));
    render(<StorageKeyRevocationCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check old key' }));
    await waitFor(() => expect(m.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  });

  it('records the operator\'s confirmation only after an explicit confirm step', async () => {
    m.fetchWithAuth
      .mockResolvedValueOnce(json({ data: [REPLACED] }))
      .mockResolvedValueOnce(json({ outcome: 'revoked' }))
      .mockResolvedValueOnce(json({ data: [] }));
    render(<StorageKeyRevocationCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'I disabled this key' }));
    expect(m.fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/weaker evidence/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(m.fetchWithAuth).toHaveBeenCalledWith(
      `/backup/storage-credentials/${REPLACED.id}/confirm-disabled`,
      { method: 'POST', body: JSON.stringify({ confirm: true }) },
    ));
    await waitFor(() => expect(screen.queryByTestId('storage-credential-revocation')).toBeNull());
  });

  it('shows a retry when the list cannot be loaded', async () => {
    m.fetchWithAuth.mockResolvedValueOnce(json({ error: 'boom' }, 500)).mockResolvedValueOnce(json({ data: [] }));
    render(<StorageKeyRevocationCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(m.fetchWithAuth).toHaveBeenCalledTimes(2));
  });
});
