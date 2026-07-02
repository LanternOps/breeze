import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BulkActionBar } from './BulkActionBar';

describe('BulkActionBar', () => {
  it('renders nothing when count is 0', () => {
    const { container } = render(<BulkActionBar count={0} actions={[]} onClear={() => {}} testIdPrefix="quotes" />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the count and fires action + clear handlers', () => {
    const onClick = vi.fn();
    const onClear = vi.fn();
    render(
      <BulkActionBar
        count={2}
        actions={[{ key: 'delete', label: 'Delete', variant: 'destructive', onClick }]}
        onClear={onClear}
        testIdPrefix="quotes"
      />
    );
    expect(screen.getByTestId('quotes-bulk-bar')).toHaveTextContent('2 selected');
    fireEvent.click(screen.getByTestId('quotes-bulk-action-delete'));
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('quotes-bulk-clear'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('renders the bar in-flow (sticky, not absolute) so the last row is never occluded', () => {
    render(
      <BulkActionBar
        count={2}
        actions={[{ key: 'delete', label: 'Delete', onClick: () => {} }]}
        onClear={() => {}}
        testIdPrefix="quotes"
      />
    );
    // A `sticky` in-flow bar occupies its own layout box, so the last table row
    // can never be occluded regardless of the bar's height — no spacer needed.
    const bar = screen.getByTestId('quotes-bulk-bar');
    expect(bar).toHaveClass('sticky');
    expect(bar).not.toHaveClass('absolute');
    // The old in-flow spacer sibling is gone.
    expect(screen.queryByTestId('bulk-bar-spacer')).not.toBeInTheDocument();
  });

  it('renders nothing (no bar) when count is 0', () => {
    render(<BulkActionBar count={0} actions={[]} onClear={() => {}} testIdPrefix="quotes" />);
    expect(screen.queryByTestId('quotes-bulk-bar')).not.toBeInTheDocument();
  });
});
