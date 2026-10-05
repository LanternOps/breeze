import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FixMemoryPage from './FixMemoryPage';
import { fetchWithAuth } from '../../stores/auth';

const authState = vi.hoisted(() => ({ canManagePartnerWide: true as boolean | undefined }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { canManagePartnerWide: authState.canManagePartnerWide } }),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const f = vi.mocked(fetchWithAuth);
const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;

const row = { id: 'm-1', scope: 'all_clients', orgId: null, fixKind: 'builtin_action', label: 'Restart service', osType: 'windows', attempts: 8, verified: 7, failed: 1, recurred: 0, successRate: 0.875, status: 'active', stale: false, lastVerifiedAt: '2026-11-01T00:00:00Z', condition: 'rule:service_stopped', signatureKeyPrefix: 'abcdef01' };
const orgRow = { ...row, id: 'm-2', scope: 'this_client', orgId: 'org-1', label: 'Clear cache', condition: null };

describe('FixMemoryPage', () => {
  beforeEach(() => { f.mockReset(); window.location.hash = ''; authState.canManagePartnerWide = true; });

  it('lists entries with track record, scope and signature', async () => {
    f.mockResolvedValue(json({ data: [row, orgRow], total: 2 }));
    render(<FixMemoryPage />);
    const r = await screen.findByTestId('fix-memory-row-m-1');
    expect(within(r).getByText('Restart service')).toBeTruthy();
    expect(within(r).getByText('7/8')).toBeTruthy();
    expect(within(r).getByText('All clients')).toBeTruthy();
    expect(within(r).getByText('rule:service_stopped')).toBeTruthy();
    expect(within(screen.getByTestId('fix-memory-row-m-2')).getByText('Signature abcdef01')).toBeTruthy();
  });

  it('filters by OS and condition through the query string', async () => {
    f.mockResolvedValue(json({ data: [], total: 0 }));
    render(<FixMemoryPage />);
    fireEvent.change(await screen.findByTestId('fix-memory-filter-os'), { target: { value: 'linux' } });
    fireEvent.change(screen.getByTestId('fix-memory-filter-condition'), { target: { value: 'disk' } });
    await waitFor(() => expect(f).toHaveBeenLastCalledWith(expect.stringMatching(/^\/fix-memory\?.*osType=linux.*condition=disk/)));
  });

  it('Retire goes through runAction and marks the row retired', async () => {
    f.mockImplementation(async (url, init) => {
      if (String(url) === '/fix-memory/m-1/retire' && init?.method === 'POST') return json({ data: { id: 'm-1', status: 'retired', changed: true } });
      return json({ data: [row], total: 1 });
    });
    render(<FixMemoryPage />);
    fireEvent.click(await screen.findByTestId('fix-memory-retire-m-1'));
    fireEvent.click(await screen.findByTestId('fix-memory-retire-confirm'));
    await waitFor(() => expect(within(screen.getByTestId('fix-memory-row-m-1')).getByText('Retired')).toBeTruthy());
    expect(screen.queryByTestId('fix-memory-retire-m-1')).toBeNull();
  });

  it('does not offer Retire on an all-clients row without partner-wide rights, but does for a client row', async () => {
    authState.canManagePartnerWide = false;
    f.mockResolvedValue(json({ data: [row, orgRow], total: 2 }));
    render(<FixMemoryPage />);
    await screen.findByTestId('fix-memory-row-m-1');
    expect(screen.queryByTestId('fix-memory-retire-m-1')).toBeNull();
    expect(screen.getByTestId('fix-memory-retire-m-2')).toBeTruthy();
  });

  it('an empty list says so (never a blank table)', async () => {
    f.mockResolvedValue(json({ data: [], total: 0 }));
    render(<FixMemoryPage />);
    expect(await screen.findByTestId('fix-memory-empty')).toBeTruthy();
  });

  it('a failed load shows an error with retry', async () => {
    f.mockResolvedValueOnce(json({ error: 'boom' }, false, 500));
    f.mockResolvedValue(json({ data: [row], total: 1 }));
    render(<FixMemoryPage />);
    fireEvent.click(await screen.findByTestId('fix-memory-retry'));
    expect(await screen.findByTestId('fix-memory-row-m-1')).toBeTruthy();
  });

  it('the Reviewed steps tab is hash-addressed and retires steps', async () => {
    window.location.hash = '#steps';
    f.mockImplementation(async (url, init) => {
      if (String(url) === '/fix-memory/instructions/fi-1/retire' && init?.method === 'POST') return json({ data: { id: 'fi-1', retired: true } });
      return json({ data: [{ id: 'fi-1', title: 'Clear print queue', steps: ['a'], osType: null, reviewedAt: '2026-11-01T00:00:00Z' }] });
    });
    render(<FixMemoryPage />);
    expect(await screen.findByTestId('fix-steps-row-fi-1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('fix-steps-retire-fi-1'));
    fireEvent.click(await screen.findByTestId('fix-memory-retire-confirm'));
    await waitFor(() => expect(screen.queryByTestId('fix-steps-row-fi-1')).toBeNull());
  });
});
