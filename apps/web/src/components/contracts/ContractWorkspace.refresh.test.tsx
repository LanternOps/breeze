import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractWorkspace from './ContractWorkspace';
import type { ContractDetail as ContractDetailData } from '../../lib/api/contracts';

// #9305: a background refresh (ContractEditor's onChanged after each field
// save) must not replace the page with the full-page spinner or remount the
// editor — that threw away focus and the per-field "Saved" cue.
const state = vi.hoisted(() => ({
  onChanged: null as null | (() => void),
  mounts: 0,
}));
const showToast = vi.hoisted(() => vi.fn());

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: 'contracts', action: 'write' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));
vi.mock('./ContractDetail', () => ({ default: () => <div data-testid="mock-contract-detail" /> }));
vi.mock('./ContractEditor', async () => {
  const React = await import('react');
  return {
    default: ({ detail, onChanged }: { detail: { contract: { name: string } }; onChanged: () => void }) => {
      state.onChanged = onChanged;
      React.useEffect(() => { state.mounts += 1; }, []);
      return <div data-testid="mock-contract-editor">{detail.contract.name}</div>;
    },
  };
});
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return { ...actual, getContract: vi.fn() };
});

import { getContract } from '../../lib/api/contracts';
import { navigateTo } from '@/lib/navigation';

const okRes = (name: string) => ({
  ok: true,
  status: 200,
  json: async () => ({
    data: { contract: { id: 'c1', name, status: 'draft' }, lines: [] } as unknown as ContractDetailData,
  }),
}) as Response;

describe('ContractWorkspace background refresh (#9305)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.mounts = 0;
    state.onChanged = null;
  });

  it('shows the spinner on first load only', async () => {
    vi.mocked(getContract).mockResolvedValue(okRes('A'));
    render(<ContractWorkspace contractId="c1" />);
    expect(screen.getByTestId('contract-workspace-loading')).toBeInTheDocument();
    await screen.findByTestId('mock-contract-editor');
    expect(screen.queryByTestId('contract-workspace-loading')).toBeNull();
  });

  it('keeps the editor mounted and swaps in new detail on refresh', async () => {
    vi.mocked(getContract).mockResolvedValueOnce(okRes('A'));
    render(<ContractWorkspace contractId="c1" />);
    const editor = await screen.findByTestId('mock-contract-editor');

    let release!: (r: Response) => void;
    vi.mocked(getContract).mockReturnValueOnce(new Promise<Response>((r) => { release = r; }));
    act(() => state.onChanged!());
    expect(screen.queryByTestId('contract-workspace-loading')).toBeNull();
    expect(screen.getByTestId('mock-contract-editor')).toBe(editor);

    await act(async () => { release(okRes('B')); });
    await waitFor(() => expect(screen.getByTestId('mock-contract-editor')).toHaveTextContent('B'));
    expect(screen.getByTestId('mock-contract-editor')).toBe(editor);
    expect(state.mounts).toBe(1);
    expect(screen.queryByTestId('contract-workspace-loading')).toBeNull();
  });

  it('keeps the last detail and toasts when a background refresh fails', async () => {
    vi.mocked(getContract).mockResolvedValueOnce(okRes('A'));
    render(<ContractWorkspace contractId="c1" />);
    await screen.findByTestId('mock-contract-editor');

    vi.mocked(getContract).mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response);
    await act(async () => { state.onChanged!(); });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/\S/) })));
    expect(screen.getByTestId('mock-contract-editor')).toHaveTextContent('A');
    expect(screen.queryByTestId('contract-workspace-error')).toBeNull();
  });

  it('still shows the error state when the first load fails', async () => {
    vi.mocked(getContract).mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response);
    render(<ContractWorkspace contractId="c1" />);
    expect(await screen.findByTestId('contract-workspace-error')).toBeInTheDocument();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('redirects to login on a 401 background refresh without toasting', async () => {
    vi.mocked(getContract).mockResolvedValueOnce(okRes('A'));
    render(<ContractWorkspace contractId="c1" />);
    await screen.findByTestId('mock-contract-editor');
    vi.mocked(getContract).mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) } as Response);
    await act(async () => { state.onChanged!(); });
    expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true });
    expect(showToast).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-contract-editor')).toHaveTextContent('A');
  });

  it('keeps the detail and toasts when a background refresh rejects', async () => {
    vi.mocked(getContract).mockResolvedValueOnce(okRes('A'));
    render(<ContractWorkspace contractId="c1" />);
    await screen.findByTestId('mock-contract-editor');
    vi.mocked(getContract).mockRejectedValueOnce(new Error('offline'));
    await act(async () => { state.onChanged!(); });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'offline' }));
    expect(screen.getByTestId('mock-contract-editor')).toHaveTextContent('A');
  });

  it('lets the newest refresh win when responses arrive out of order', async () => {
    vi.mocked(getContract).mockResolvedValueOnce(okRes('A'));
    render(<ContractWorkspace contractId="c1" />);
    await screen.findByTestId('mock-contract-editor');
    let releaseOld!: (r: Response) => void;
    let releaseNew!: (r: Response) => void;
    vi.mocked(getContract)
      .mockReturnValueOnce(new Promise<Response>((r) => { releaseOld = r; }))
      .mockReturnValueOnce(new Promise<Response>((r) => { releaseNew = r; }));
    act(() => { state.onChanged!(); });
    act(() => { state.onChanged!(); });
    await act(async () => { releaseNew(okRes('NEW')); });
    await waitFor(() => expect(screen.getByTestId('mock-contract-editor')).toHaveTextContent('NEW'));
    await act(async () => { releaseOld(okRes('OLD')); });
    expect(screen.getByTestId('mock-contract-editor')).toHaveTextContent('NEW');
  });
});
