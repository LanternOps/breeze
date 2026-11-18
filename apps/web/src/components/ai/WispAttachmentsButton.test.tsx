import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('@/stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/runAction', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/runAction')>()), runAction: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

import WispAttachmentsButton from './WispAttachmentsButton';
import type { WispState } from '@/stores/aiStore';

type Wisp = NonNullable<WispState>;
const wisp = (over: Partial<Wisp> = {}) => ({ threadId: 't1', scopeOrgId: 'o1', focusOrgId: 'o1', ...over }) as unknown as Wisp;
const item = (id: string, label: string) => ({ id, label, bytes: 2048, expiresAt: '2026-12-01T00:00:00Z' });
const listRes = (data: unknown[]) => ({ ok: true, status: 200, json: async () => ({ data }) });

beforeEach(() => {
  vi.clearAllMocks();
  fetchWithAuth.mockResolvedValue(listRes([]));
});

describe('WispAttachmentsButton (composer paperclip)', () => {
  it('shows a count badge once the thread has attachments, none when it has none', async () => {
    fetchWithAuth.mockResolvedValueOnce(listRes([item('1', 'Invoice mail'), item('2', 'CSV')]));
    const { unmount } = render(<WispAttachmentsButton wisp={wisp()} />);
    expect(await screen.findByTestId('wisp-attachments-count')).toHaveTextContent('2');
    unmount();
    render(<WispAttachmentsButton wisp={wisp()} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('wisp-attachments-count')).toBeNull();
  });

  it('opens a popover holding the attachments without repeating their title, and reuses the loaded list', async () => {
    fetchWithAuth.mockResolvedValueOnce(listRes([item('1', 'Invoice mail')]));
    render(<WispAttachmentsButton wisp={wisp()} />);
    await screen.findByTestId('wisp-attachments-count');
    const toggle = screen.getByTestId('wisp-attachments-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const pop = screen.getByTestId('wisp-attachments-popover');
    expect(pop).toHaveAttribute('role', 'dialog');
    expect(pop).toHaveAttribute('aria-label', 'Attached to this thread');
    expect(within(pop).getByTestId('wisp-attachments')).toBeInTheDocument();
    expect(within(pop).queryByText('Attached to this thread')).toBeNull();
    expect(within(pop).getAllByTestId('wisp-attachment-item')[0]).toHaveTextContent('Invoice mail');
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  // The badge can say "2" before a focus is picked: the list must stay
  // reachable, with the reason on screen (not a hover-only title).
  it('on a partner-wide grant with no focus it still opens: the existing attachments, and the reason inline as the dialog\'s description', async () => {
    fetchWithAuth.mockResolvedValueOnce(listRes([item('1', 'Invoice mail'), item('2', 'CSV')]));
    render(<WispAttachmentsButton wisp={wisp({ scopeOrgId: null, focusOrgId: null })} />);
    expect(await screen.findByTestId('wisp-attachments-count')).toHaveTextContent('2');
    const toggle = screen.getByTestId('wisp-attachments-toggle');
    expect(toggle).not.toHaveAttribute('aria-disabled');
    expect(toggle).not.toHaveAttribute('title', 'Pick a customer focus before attaching');
    fireEvent.click(toggle);
    const pop = screen.getByTestId('wisp-attachments-popover');
    expect(within(pop).getAllByTestId('wisp-attachment-item').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Invoice mail'),
      expect.stringContaining('CSV'),
    ]);
    const reason = within(pop).getByTestId('wisp-attachments-focus-required');
    expect(reason).toHaveTextContent('Pick a customer focus before attaching');
    expect(reason.id).not.toBe('');
    expect(pop).toHaveAttribute('aria-describedby', reason.id);
    expect(toggle).toHaveAttribute('aria-describedby', reason.id);
    // Nothing in it can attach, so focus lands on the dialog, which announces the reason.
    expect(within(pop).getByTestId('wisp-attachment-paste')).toBeDisabled();
    expect(pop).toHaveFocus();
  });

  it('a partner-wide grant with a customer focus can attach', () => {
    render(<WispAttachmentsButton wisp={wisp({ scopeOrgId: null, focusOrgId: 'o2' })} />);
    const toggle = screen.getByTestId('wisp-attachments-toggle');
    expect(toggle).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(toggle);
    const pop = screen.getByTestId('wisp-attachments-popover');
    expect(screen.queryByTestId('wisp-attachments-focus-required')).toBeNull();
    expect(pop).not.toHaveAttribute('aria-describedby');
  });
});
