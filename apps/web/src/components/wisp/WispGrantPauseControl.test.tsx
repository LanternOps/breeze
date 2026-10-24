import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WispState } from '@/stores/aiStore';

const h = vi.hoisted(() => ({ runAction: vi.fn(), fetchWithAuth: vi.fn(), showToast: vi.fn() }));
vi.mock('@/lib/runAction', () => ({
  runAction: (o: unknown) => h.runAction(o),
  ActionError: class ActionError extends Error { status = 0; },
}));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: h.fetchWithAuth }));
vi.mock('@/components/shared/Toast', () => ({ showToast: (...a: unknown[]) => h.showToast(...a) }));

import WispGrantPauseControl from './WispGrantPauseControl';

function wisp(o: Partial<NonNullable<WispState>> = {}): NonNullable<WispState> {
  return {
    grantId: 'g-1', threadId: 't-1', scopeOrgId: null, focusOrgId: null, focusOrgName: null, status: 'active',
    expiresAt: '2027-01-01T00:00:00.000Z', summary: '', budgetCentsPerDay: 200, floorTickMinutes: 30, wideningAvailable: false,
    pausedReason: null, ...o,
  };
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
  h.runAction.mockImplementation(async (o: { request: () => Promise<Response> }) => (await o.request()).json());
});

describe('WispGrantPauseControl (W06 T15, w00 A29)', () => {
  it('pauses an active grant through runAction and reports the server status', async () => {
    h.fetchWithAuth.mockResolvedValue(ok({ id: 'g-1', status: 'paused', pausedReason: 'user_paused' }));
    const onChange = vi.fn();
    render(<WispGrantPauseControl wisp={wisp()} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('wisp-pause'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ status: 'paused', pausedReason: 'user_paused' }));
    expect(h.runAction).toHaveBeenCalledTimes(1);
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/grants/g-1/pause', { method: 'POST' });
  });

  it('shows the "you paused" banner and an enabled Resume for a user-paused grant', async () => {
    h.fetchWithAuth.mockResolvedValue(ok({ id: 'g-1', status: 'active', pausedReason: null }));
    const onChange = vi.fn();
    render(<WispGrantPauseControl wisp={wisp({ status: 'paused', pausedReason: 'user_paused' })} onChange={onChange} />);
    expect(screen.getByTestId('wisp-paused-by-you')).toBeTruthy();
    const resume = screen.getByTestId('wisp-resume') as HTMLButtonElement;
    expect(resume.disabled).toBe(false);
    fireEvent.click(resume);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ status: 'active', pausedReason: null }));
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/grants/g-1/resume', { method: 'POST' });
  });

  it('disables Resume for a system pause and shows no "you paused" banner', () => {
    render(<WispGrantPauseControl wisp={wisp({ status: 'paused', pausedReason: 'entitlement_lapsed' })} onChange={vi.fn()} />);
    expect((screen.getByTestId('wisp-resume') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('wisp-paused-by-you')).toBeNull();
  });

  it('learns an unknown pause reason from GET /wisp/grants (read, not runAction)', async () => {
    h.fetchWithAuth.mockResolvedValue(ok({ grants: [{ id: 'other', pausedReason: null }, { id: 'g-1', status: 'paused', pausedReason: 'user_paused' }] }));
    const onChange = vi.fn();
    render(<WispGrantPauseControl wisp={wisp({ status: 'paused', pausedReason: undefined })} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ pausedReason: 'user_paused' }));
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/grants');
    expect(h.runAction).not.toHaveBeenCalled();
  });

  it('renders nothing for a revoked or expired grant', () => {
    const { container } = render(<WispGrantPauseControl wisp={wisp({ status: 'revoked' })} onChange={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('a failed pause changes nothing (runAction already toasted)', async () => {
    const { ActionError } = await import('@/lib/runAction');
    h.runAction.mockRejectedValue(Object.assign(new ActionError('nope', 409), { status: 409 }));
    const onChange = vi.fn();
    render(<WispGrantPauseControl wisp={wisp()} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('wisp-pause'));
    await waitFor(() => expect((screen.getByTestId('wisp-pause') as HTMLButtonElement).disabled).toBe(false));
    expect(onChange).not.toHaveBeenCalled();
    expect(h.showToast).not.toHaveBeenCalled();
  });
});
