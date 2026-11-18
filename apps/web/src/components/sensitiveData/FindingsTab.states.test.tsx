import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import FindingsTab from './FindingsTab';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./RemediationModal', () => ({ default: () => null }));

const fetchMock = vi.mocked(fetchWithAuth);

const makeFinding = (id: string, filePath: string) => ({
  id,
  deviceId: 'dev-1',
  deviceName: 'host-1',
  filePath,
  dataType: 'credential',
  patternId: 'aws_access_key',
  risk: 'high',
  confidence: 0.9,
  status: 'open',
  lastSeenAt: '2026-05-21T00:00:00Z',
  createdAt: '2026-05-21T00:00:00Z',
});

const res = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: async () => payload }) as unknown as Response;

const page = (rows: unknown[]) => ({
  data: rows,
  pagination: { page: 1, limit: 25, total: rows.length, totalPages: 1 },
});

describe('FindingsTab access state + stale rows (#9697)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  it('shows the no-access state on a 403 instead of a generic fetch error', async () => {
    fetchMock.mockResolvedValue(res({ error: 'Organization access denied' }, 403));
    render(<FindingsTab />);
    expect(await screen.findByText(/You don't have access to this organization/i)).toBeInTheDocument();
    expect(screen.queryByText('Failed to fetch findings')).not.toBeInTheDocument();
  });

  it('clears the previous rows when a later fetch fails', async () => {
    fetchMock.mockResolvedValueOnce(res(page([makeFinding('f1', '/home/u/stale-row.txt')])));
    render(<FindingsTab />);
    expect(await screen.findByText('/home/u/stale-row.txt')).toBeInTheDocument();

    fetchMock.mockResolvedValue(res({ error: 'boom' }, 500));
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'high' } });

    expect(await screen.findByText('Failed to fetch findings')).toBeInTheDocument();
    expect(screen.queryByText('/home/u/stale-row.txt')).not.toBeInTheDocument();
  });

  it('drops the previous rows when a later fetch is a 403', async () => {
    fetchMock.mockResolvedValueOnce(res(page([makeFinding('f1', '/home/u/stale-row.txt')])));
    render(<FindingsTab />);
    expect(await screen.findByText('/home/u/stale-row.txt')).toBeInTheDocument();

    fetchMock.mockResolvedValue(res({ error: 'denied' }, 403));
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'high' } });

    expect(await screen.findByText(/You don't have access to this organization/i)).toBeInTheDocument();
    expect(screen.queryByText('/home/u/stale-row.txt')).not.toBeInTheDocument();
  });
});

describe('FindingsTab data-type labels (#9683)', () => {
  it('renders PCI / Credentials, not raw lower-case keys', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      res(page([
        { ...makeFinding('f1', '/a'), dataType: 'pci' },
        { ...makeFinding('f2', '/b'), dataType: 'credential' },
      ]))
    );
    render(<FindingsTab />);
    await screen.findByText('/a');
    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('PCI');
    expect(rows[2]).toHaveTextContent('Credentials');
  });
});

describe('FindingsTab quick actions (#9683)', () => {
  const OPEN = page([makeFinding('f1', '/home/u/quick.txt')]);

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  it('Accept toasts success', async () => {
    fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) =>
      String(url) === '/sensitive-data/remediate' && init?.method === 'POST'
        ? res({ success: true })
        : res(OPEN)
    );
    render(<FindingsTab />);
    await screen.findByText('/home/u/quick.txt');
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Risk accepted' }))
    );
  });

  it('FP success toasts "Marked as false positive"', async () => {
    fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) =>
      String(url) === '/sensitive-data/remediate' && init?.method === 'POST'
        ? res({ success: true })
        : res(OPEN)
    );
    render(<FindingsTab />);
    await screen.findByText('/home/u/quick.txt');
    fireEvent.click(screen.getByRole('button', { name: 'FP' }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: 'Marked as false positive' })
      )
    );
  });

  it('failure toasts the server error', async () => {
    fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) =>
      String(url) === '/sensitive-data/remediate' && init?.method === 'POST'
        ? res({ error: 'Remediation denied' }, 400)
        : res(OPEN)
    );
    render(<FindingsTab />);
    await screen.findByText('/home/u/quick.txt');
    fireEvent.click(screen.getByRole('button', { name: 'FP' }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Remediation denied' }))
    );
  });
});
