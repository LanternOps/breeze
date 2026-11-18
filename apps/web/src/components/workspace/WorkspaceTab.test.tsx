import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WorkspaceTab from './WorkspaceTab';

function renderTab(overrides: Partial<React.ComponentProps<typeof WorkspaceTab>> = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const onRename = vi.fn();
  render(
    <WorkspaceTab
      id="tab-1"
      title="Printer troubleshooting"
      isActive={false}
      unreadCount={0}
      hasApprovalPending={false}
      isStreaming={false}
      onSelect={onSelect}
      onClose={onClose}
      onRename={onRename}
      {...overrides}
    />,
  );
  return { onSelect, onClose, onRename };
}

describe('WorkspaceTab structure and menu (#9840 W3, Gate B #8)', () => {
  it('the root is a div role="tab" and no interactive element nests inside a button', () => {
    renderTab({ isActive: true, onContinueInPanel: vi.fn() });
    const root = screen.getByTestId('workspace-tab');
    expect(root.tagName).toBe('DIV');
    expect(root).toHaveAttribute('role', 'tab');
    expect(root).toHaveAttribute('aria-selected', 'true');
    expect(root.querySelectorAll('button button, button [role="button"], button input')).toHaveLength(0);
  });

  it('clicking the tab’s select button selects it', () => {
    const { onSelect } = renderTab();
    fireEvent.click(screen.getByTestId('workspace-tab-select'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('the close button closes without selecting', () => {
    const { onSelect, onClose } = renderTab();
    fireEvent.click(screen.getByTestId('workspace-tab-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('the menu offers Rename, which opens the rename input', () => {
    renderTab();
    const trigger = screen.getByTestId('workspace-tab-menu');
    expect(trigger).toHaveAttribute('aria-label', 'Tab options');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename chat' }));
    expect(screen.getByTestId('workspace-tab-rename-input')).toBeInTheDocument();
  });

  it('the menu’s "Continue in side panel" calls onContinueInPanel', () => {
    const onContinueInPanel = vi.fn();
    renderTab({ onContinueInPanel });
    fireEvent.click(screen.getByTestId('workspace-tab-menu'));
    fireEvent.click(screen.getByTestId('workspace-tab-continue-in-panel'));
    expect(onContinueInPanel).toHaveBeenCalledTimes(1);
  });

  it('no "Continue in side panel" item without a session to move', () => {
    renderTab({ onContinueInPanel: undefined });
    fireEvent.click(screen.getByTestId('workspace-tab-menu'));
    expect(screen.queryByTestId('workspace-tab-continue-in-panel')).toBeNull();
  });
});

describe('WorkspaceTab rename', () => {
  it('renders the title as plain text (not editable) by default', () => {
    renderTab();
    expect(screen.getByTestId('workspace-tab-title')).toHaveTextContent('Printer troubleshooting');
    expect(screen.queryByTestId('workspace-tab-rename-input')).not.toBeInTheDocument();
  });

  it('double-clicking the title swaps it for an editable input, pre-filled with the current title', () => {
    renderTab();

    fireEvent.doubleClick(screen.getByTestId('workspace-tab-title'));

    const input = screen.getByTestId('workspace-tab-rename-input') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe('Printer troubleshooting');
  });

  it('commits the new title on Enter', () => {
    const { onRename } = renderTab();
    fireEvent.doubleClick(screen.getByTestId('workspace-tab-title'));

    const input = screen.getByTestId('workspace-tab-rename-input');
    fireEvent.change(input, { target: { value: 'Renamed chat' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).toHaveBeenCalledWith('Renamed chat');
    expect(screen.queryByTestId('workspace-tab-rename-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('workspace-tab-title')).toHaveTextContent('Printer troubleshooting');
  });

  it('commits the new title on blur', () => {
    const { onRename } = renderTab();
    fireEvent.doubleClick(screen.getByTestId('workspace-tab-title'));

    const input = screen.getByTestId('workspace-tab-rename-input');
    fireEvent.change(input, { target: { value: 'Renamed via blur' } });
    fireEvent.blur(input);

    expect(onRename).toHaveBeenCalledWith('Renamed via blur');
  });

  it('discards the edit on Escape without calling onRename', () => {
    const { onRename } = renderTab();
    fireEvent.doubleClick(screen.getByTestId('workspace-tab-title'));

    const input = screen.getByTestId('workspace-tab-rename-input');
    fireEvent.change(input, { target: { value: 'Should not save' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByTestId('workspace-tab-rename-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('workspace-tab-title')).toHaveTextContent('Printer troubleshooting');
  });

  it('does not call onRename when the title is unchanged', () => {
    const { onRename } = renderTab();
    fireEvent.doubleClick(screen.getByTestId('workspace-tab-title'));

    const input = screen.getByTestId('workspace-tab-rename-input');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).not.toHaveBeenCalled();
  });

  it('does not call onRename when the new title is blank', () => {
    const { onRename } = renderTab();
    fireEvent.doubleClick(screen.getByTestId('workspace-tab-title'));

    const input = screen.getByTestId('workspace-tab-rename-input');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRename).not.toHaveBeenCalled();
  });

  it('does not fire onSelect when double-clicking the title to rename', () => {
    const { onSelect } = renderTab();
    fireEvent.doubleClick(screen.getByTestId('workspace-tab-title'));

    // The dblclick itself is stopped from bubbling to the tab button; a
    // regular click still selects the tab as usual, so onSelect isn't
    // expected to have been suppressed globally — only the rename trigger.
    expect(screen.getByTestId('workspace-tab-rename-input')).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
