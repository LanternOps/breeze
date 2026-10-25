/**
 * #9840 W4 (Task 16): "Open a past conversation" — the shared list on the
 * workspace surface, in a Dialog. It lists only what the workspace can open
 * (no topology rows, no closed hits: D4), mounts its source only while open,
 * and hands a pick to the page.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('@/stores/orgStore', async () => {
  const { create: mk } = await import('zustand');
  const useOrgStore = mk<{ organizations: Array<{ id: string; name: string }>; currentOrgId: string | null }>(() => ({
    organizations: [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Beta' }], currentOrgId: 'org-1',
  }));
  return { useOrgStore };
});
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

import WorkspaceConversationPicker from './WorkspaceConversationPicker';
import { fetchWithAuth } from '@/stores/auth';
import { useAiStore } from '@/stores/aiStore';
import { useWorkspaceStore, type TabState } from '@/stores/workspaceStore';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const T = '33333333-3333-4333-8333-333333333333';
const C = '44444444-4444-4444-8444-444444444444';
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `Chat ${id.slice(0, 4)}`, status: 'active', createdAt: '2026-10-20T09:00:00.000Z',
  orgId: 'org-1', type: 'general', deviceId: null, ...over,
});
const urls = () => fetchMock.mock.calls.map(([u]) => String(u));
const rowIds = () => screen.queryAllByTestId('ai-conversation-row').map((el) => el.dataset.sessionId);

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string | URL | Request) => {
    const u = String(url);
    if (u === '/ai/sessions?status=active') {
      return json({ data: [row(A), row(B, { orgId: 'org-2', deviceId: 'dev-1' }), row(T, { type: 'topology' }), row(C, { type: 'script_builder' })] });
    }
    if (u.startsWith('/ai/sessions/search')) {
      return json({ data: [row(A, { matchedContent: 'x' }), row(B, { status: 'closed', matchedContent: 'y' })] });
    }
    return json({}, 404);
  });
  useWorkspaceStore.setState({ tabs: [], activeTabId: null });
  useAiStore.setState({ sessionId: null });
});

describe('WorkspaceConversationPicker', () => {
  it('closed: renders nothing and fetches nothing', () => {
    render(<WorkspaceConversationPicker open={false} onClose={vi.fn()} onPick={vi.fn()} />);
    expect(screen.queryByTestId('workspace-conversation-picker')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('open: a titled dialog listing only what the workspace can open (no topology, no non-chat types)', async () => {
    render(<WorkspaceConversationPicker open onClose={vi.fn()} onPick={vi.fn()} />);
    const picker = screen.getByTestId('workspace-conversation-picker');
    expect(screen.getByRole('dialog')).toContainElement(picker);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Open a past conversation');
    expect(picker).toHaveTextContent('Open a past conversation');
    await waitFor(() => expect(rowIds()).toEqual([A, B]));
    expect(urls().filter((u) => u === '/ai/sessions?status=active')).toHaveLength(1);
  });

  it('rows carry the org and Device chips', async () => {
    render(<WorkspaceConversationPicker open onClose={vi.fn()} onPick={vi.fn()} />);
    await waitFor(() => expect(rowIds()).toEqual([A, B]));
    const b = screen.getAllByTestId('ai-conversation-row')[1]!;
    expect(b.querySelector('[data-testid="workspace-chip-org"]')).toHaveTextContent('Beta');
    expect(b.querySelector('[data-testid="workspace-chip-device"]')).toHaveTextContent('Device');
  });

  it('search lists only active hits', async () => {
    render(<WorkspaceConversationPicker open onClose={vi.fn()} onPick={vi.fn()} />);
    await waitFor(() => expect(rowIds()).toEqual([A, B]));
    fireEvent.change(screen.getByTestId('ai-conversation-search'), { target: { value: 'pa' } });
    await waitFor(() => expect(urls().some((u) => u.startsWith('/ai/sessions/search'))).toBe(true), { timeout: 2000 });
    await waitFor(() => expect(rowIds()).toEqual([A]));
  });

  it('a row the side panel holds says "Open in side panel"; the active tab is marked current', async () => {
    useAiStore.setState({ sessionId: B });
    useWorkspaceStore.setState({ tabs: [{ id: 'tab-a', sessionId: A } as unknown as TabState], activeTabId: 'tab-a' });
    render(<WorkspaceConversationPicker open onClose={vi.fn()} onPick={vi.fn()} />);
    await waitFor(() => expect(rowIds()).toEqual([A, B]));
    const [a, b] = screen.getAllByTestId('ai-conversation-row');
    expect(b!.querySelector('[data-testid="ai-conversation-open-elsewhere"]')).toHaveTextContent('Open in side panel');
    expect(a!.querySelector('[data-testid="ai-conversation-open-elsewhere"]')).toBeNull();
    expect(a).toHaveAttribute('aria-current', 'true');
  });

  it('a pick goes to the host with the row', async () => {
    const onPick = vi.fn();
    render(<WorkspaceConversationPicker open onClose={vi.fn()} onPick={onPick} />);
    await waitFor(() => expect(rowIds()).toEqual([A, B]));
    fireEvent.click(screen.getAllByTestId('ai-conversation-row')[0]!);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: A, openIn: null }));
  });

  it('Escape asks the host to close', () => {
    const onClose = vi.fn();
    render(<WorkspaceConversationPicker open onClose={onClose} onPick={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closing and reopening resets the query and lists again', async () => {
    const { rerender } = render(<WorkspaceConversationPicker open onClose={vi.fn()} onPick={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ai-conversation-search'), { target: { value: 'pa' } });
    rerender(<WorkspaceConversationPicker open={false} onClose={vi.fn()} onPick={vi.fn()} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    rerender(<WorkspaceConversationPicker open onClose={vi.fn()} onPick={vi.fn()} />);
    expect(screen.getByTestId('ai-conversation-search')).toHaveValue('');
    await waitFor(() => expect(urls().filter((u) => u === '/ai/sessions?status=active')).toHaveLength(2));
  });
});
