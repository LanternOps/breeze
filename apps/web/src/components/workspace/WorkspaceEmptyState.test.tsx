/** #9840 W4 (Task 16): the empty workspace offers "Open a past conversation" too. */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WorkspaceEmptyState from './WorkspaceEmptyState';

describe('WorkspaceEmptyState', () => {
  it('offers New Conversation and, under it, Open a past conversation; the limit line stays', () => {
    const onCreateTab = vi.fn();
    const onOpenPast = vi.fn();
    render(<WorkspaceEmptyState onCreateTab={onCreateTab} onOpenPast={onOpenPast} />);
    const create = screen.getByRole('button', { name: /New Conversation/ });
    const past = screen.getByTestId('workspace-empty-open-past');
    expect(past).toHaveTextContent('Open a past conversation');
    expect(create.compareDocumentPosition(past) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Up to 5 concurrent conversations')).toBeInTheDocument();

    fireEvent.click(past);
    expect(onOpenPast).toHaveBeenCalledTimes(1);
    expect(onCreateTab).not.toHaveBeenCalled();
    fireEvent.click(create);
    expect(onCreateTab).toHaveBeenCalledTimes(1);
  });
});
