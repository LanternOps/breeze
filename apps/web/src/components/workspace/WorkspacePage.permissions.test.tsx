import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// #6498: /workspace is the full-page AI Assistant. #6396/#6399 gated the header
// button and the docked sidebar on `ai_sessions:use` but not this page, so a
// role holding only devices:read got a composer that 403s on send. The page
// must render the AccessDenied state instead — and must not touch /ai/sessions.

type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [] as Perm[] | undefined }));

vi.mock('@/lib/permissions', async () => {
  const actual = await vi.importActual<typeof import('@/lib/permissions')>('@/lib/permissions');
  return {
    ...actual,
    usePermissions: () => ({
      permissions: state.permissions,
      can: (resource: string, action: string) =>
        actual.hasPermission(state.permissions as never, resource as never, action as never),
    }),
  };
});

const store = vi.hoisted(() => ({
  tabs: [] as unknown[],
  activeTabId: null as string | null,
  createTab: vi.fn(),
  closeTab: vi.fn(),
  switchTab: vi.fn(),
  renameTab: vi.fn(),
  restoreWorkspace: vi.fn(async () => undefined),
  cleanupAllStreams: vi.fn(),
}));
vi.mock('@/stores/workspaceStore', () => ({ useWorkspaceStore: () => store }));
vi.mock('./WorkspaceTabBar', () => ({ default: () => <div data-testid="workspace-tab-bar" /> }));
vi.mock('./WorkspaceChatPanel', () => ({ default: () => <div data-testid="workspace-chat-panel" /> }));
vi.mock('./WorkspaceEmptyState', () => ({ default: () => <div data-testid="workspace-empty-state" /> }));

import WorkspacePage from './WorkspacePage';

const AI_USE: Perm = { resource: 'ai_sessions', action: 'use' };
const DEVICES_READ: Perm = { resource: 'devices', action: 'read' };

describe('WorkspacePage - ai_sessions:use gate (#6498)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.tabs = [];
    store.activeTabId = null;
  });

  it('renders the access-denied state for a role without ai_sessions:use', () => {
    state.permissions = [DEVICES_READ];
    render(<WorkspacePage />);

    expect(screen.getByTestId('workspace-access-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-empty-state')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workspace-tab-bar')).not.toBeInTheDocument();
  });

  it('does not restore the workspace (no /ai/sessions calls) without the permission', () => {
    state.permissions = [DEVICES_READ];
    render(<WorkspacePage />);

    expect(store.restoreWorkspace).not.toHaveBeenCalled();
    expect(store.createTab).not.toHaveBeenCalled();
  });

  it('keeps the workspace hidden while permissions are still loading', () => {
    state.permissions = undefined;
    render(<WorkspacePage />);

    expect(screen.queryByTestId('workspace-empty-state')).not.toBeInTheDocument();
    expect(store.restoreWorkspace).not.toHaveBeenCalled();
  });

  it('renders the workspace and restores it for a role holding ai_sessions:use', () => {
    state.permissions = [DEVICES_READ, AI_USE];
    render(<WorkspacePage />);

    expect(screen.getByTestId('workspace-empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-access-denied')).not.toBeInTheDocument();
    expect(store.restoreWorkspace).toHaveBeenCalled();
  });

  it('renders the tab bar and chat panel for a wildcard admin', () => {
    state.permissions = [{ resource: '*', action: '*' }];
    store.tabs = [{ id: 't1' }];
    store.activeTabId = 't1';
    render(<WorkspacePage />);

    expect(screen.getByTestId('workspace-tab-bar')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-chat-panel')).toBeInTheDocument();
  });
});
