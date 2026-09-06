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
