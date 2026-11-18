/**
 * #9840 W4 (Task 16): the tab bar's "+" is a two-item menu — "New chat" and
 * "Open a past conversation". At MAX_TABS the trigger stays, both items are
 * disabled, and "Open a past conversation" says to close a tab.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./WorkspaceTab', () => ({ default: ({ title }: { title: string }) => <div role="tab">{title}</div> }));

import WorkspaceTabBar from './WorkspaceTabBar';
import { MAX_TABS, type TabState } from '@/stores/workspaceStore';

const tabs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `Tab ${i}`, sessionId: null } as unknown as TabState));

function renderBar(n: number, opts: { grantActive?: boolean } = {}) {
  const onNewTab = vi.fn();
  const onNewPlainTab = vi.fn();
  const onOpenPast = vi.fn();
  render(
    <WorkspaceTabBar
      tabs={tabs(n)}
      activeTabId="t0"
      onSelectTab={vi.fn()}
      onCloseTab={vi.fn()}
      onRenameTab={vi.fn()}
      onNewTab={onNewTab}
      onNewPlainTab={onNewPlainTab}
      wispGrantActive={opts.grantActive ?? false}
      onOpenPast={onOpenPast}
    />,
  );
  return { onNewTab, onNewPlainTab, onOpenPast };
}

describe('the "+" menu with an active Wisp grant (#10289)', () => {
  it('offers "New plain chat" next to the grant-backed "New chat"', async () => {
    const user = userEvent.setup();
    const { onNewTab, onNewPlainTab } = renderBar(1, { grantActive: true });
    await user.click(screen.getByTestId('workspace-new-tab-menu'));
    expect(screen.getByTestId('workspace-new-chat')).toHaveTextContent('New chat');
    expect(screen.getByTestId('workspace-new-chat')).toHaveTextContent('Wisp, under your grant');
    expect(screen.getByTestId('workspace-new-plain-chat')).toHaveTextContent('New plain chat');
    await user.click(screen.getByTestId('workspace-new-plain-chat'));
    expect(onNewPlainTab).toHaveBeenCalledTimes(1);
    expect(onNewTab).not.toHaveBeenCalled();
  });

  it('without a grant there is no plain option and "New chat" has no description', async () => {
    const user = userEvent.setup();
    renderBar(1);
    await user.click(screen.getByTestId('workspace-new-tab-menu'));
    expect(screen.queryByTestId('workspace-new-plain-chat')).toBeNull();
    expect(screen.getByTestId('workspace-new-chat').textContent).toBe('New chat');
  });

  it(`at ${MAX_TABS} tabs "New plain chat" is disabled too`, async () => {
    const user = userEvent.setup();
    const { onNewPlainTab } = renderBar(MAX_TABS, { grantActive: true });
    await user.click(screen.getByTestId('workspace-new-tab-menu'));
    const plain = screen.getByTestId('workspace-new-plain-chat');
    expect(plain).toHaveAttribute('aria-disabled', 'true');
    await user.click(plain);
    expect(onNewPlainTab).not.toHaveBeenCalled();
  });
});

describe('the "+" menu', () => {
  it('keeps the trigger look (New, with the shortcut hint) and opens a menu with both items', async () => {
    const user = userEvent.setup();
    renderBar(1);
    const trigger = screen.getByTestId('workspace-new-tab-menu');
    expect(trigger).toHaveTextContent('New');
    expect(trigger).toHaveAttribute('title', 'New tab (Cmd+Shift+N)');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await user.click(trigger);
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['New chat', 'Open a past conversation']);
  });

  it('"New chat" calls onNewTab; "Open a past conversation" calls onOpenPast', async () => {
    const user = userEvent.setup();
    const { onNewTab, onOpenPast } = renderBar(2);
    await user.click(screen.getByTestId('workspace-new-tab-menu'));
    await user.click(screen.getByTestId('workspace-new-chat'));
    expect(onNewTab).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId('workspace-new-tab-menu'));
    await user.click(screen.getByTestId('workspace-open-past'));
    expect(onOpenPast).toHaveBeenCalledTimes(1);
  });

  it(`at ${MAX_TABS} tabs the trigger stays; both items are disabled with the hint, and nothing fires`, async () => {
    const user = userEvent.setup();
    const { onNewTab, onOpenPast } = renderBar(MAX_TABS);
    const trigger = screen.getByTestId('workspace-new-tab-menu');
    await user.click(trigger);
    const newChat = screen.getByTestId('workspace-new-chat');
    const openPast = screen.getByTestId('workspace-open-past');
    expect(newChat).toHaveAttribute('aria-disabled', 'true');
    expect(openPast).toHaveAttribute('aria-disabled', 'true');
    expect(openPast).toHaveTextContent('Close a tab to open this conversation');
    await user.click(newChat);
    await user.click(openPast);
    openPast.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onNewTab).not.toHaveBeenCalled();
    expect(onOpenPast).not.toHaveBeenCalled();
  });

  it('under the cap neither item is disabled and there is no hint', async () => {
    const user = userEvent.setup();
    renderBar(MAX_TABS - 1);
    await user.click(screen.getByTestId('workspace-new-tab-menu'));
    expect(screen.getByTestId('workspace-new-chat')).not.toHaveAttribute('aria-disabled');
    expect(screen.getByTestId('workspace-open-past')).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByText('Close a tab to open this conversation')).toBeNull();
  });
});
