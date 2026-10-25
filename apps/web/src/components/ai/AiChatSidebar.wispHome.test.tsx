/**
 * W08 (#9921) Task 10: in Wisp mode the docked panel defers to the Wisp home —
 * an "Open in Wisp" link to /wisp, and no in-panel concern list (the home's
 * "needs your attention" owns it). Plain chat is untouched.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })), registerOrgIdProvider: vi.fn() }));
vi.mock('@/stores/orgStore', async () => {
  const { create: mk } = await import('zustand');
  return { useOrgStore: mk(() => ({ organizations: [], currentOrgId: null })) };
});
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ permissions: [], can: () => true }) }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('astro:transitions/client', () => ({ navigate: vi.fn() }));
vi.mock('./AiChatMessages', () => ({ default: () => null }));
vi.mock('./AiChatInput', () => ({ default: () => null }));
vi.mock('./AiContextBadge', () => ({ default: () => null }));
vi.mock('./AiCostIndicator', () => ({ default: () => null }));
vi.mock('./AiModelPicker', () => ({ default: () => null }));
vi.mock('./AiContinuationPrompt', () => ({ default: () => null }));
vi.mock('./WispToggle', () => ({ default: () => null }));
vi.mock('./WispThreadHeader', () => ({ default: () => <div data-testid="wisp-thread-header-mock" /> }));
vi.mock('./WispThreadAttachments', () => ({ default: () => null }));
vi.mock('./WispConcernsPanel', () => ({ WispConcernsPanel: () => <div data-testid="wisp-concerns-mock" /> }));

import AiChatSidebar from './AiChatSidebar';
import { useAiStore, type WispState } from '@/stores/aiStore';

const wisp = (): NonNullable<WispState> => ({
  grantId: 'grant-1', threadId: 'thread-1', scopeOrgId: null, focusOrgId: null, focusOrgName: null,
  status: 'active', expiresAt: '2027-01-01T00:00:00.000Z', summary: '', budgetCentsPerDay: 200,
  floorTickMinutes: 30, wideningAvailable: false,
});

describe('AiChatSidebar in Wisp mode defers to the home (W08 Task 10)', () => {
  beforeEach(() => {
    useAiStore.setState({
      isOpen: true, showHistory: false, sessionId: null, hydratedSessionId: null, messages: [],
      isStreaming: false, isLoading: false, error: null, errorCode: null, composerDraft: '',
      topologySiteId: null, joinedMidResponse: false, wisp: null,
    });
  });

  it('Wisp mode: "Open in Wisp" links to /wisp and the concern list is gone (the header stays)', () => {
    useAiStore.setState({ wisp: wisp() });
    render(<AiChatSidebar />);
    expect(screen.getByTestId('wisp-thread-header-mock')).toBeInTheDocument();
    const link = screen.getByTestId('wisp-sidebar-open-home');
    expect(link).toHaveAttribute('href', '/wisp');
    expect(link).toHaveTextContent('Open in Wisp');
    expect(screen.queryByTestId('wisp-concerns-mock')).toBeNull();
  });

  it('plain chat: no Wisp link', () => {
    render(<AiChatSidebar />);
    expect(screen.queryByTestId('wisp-sidebar-open-home')).toBeNull();
  });
});
