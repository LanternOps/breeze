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

  it('reserves its own space with an in-flow spacer so the last row is never occluded', () => {
    render(
      <BulkActionBar
        count={2}
        actions={[{ key: 'delete', label: 'Delete', onClick: () => {} }]}
        onClear={() => {}}
        testIdPrefix="quotes"
      />
    );
    // The floating bar is absolutely positioned; a sibling spacer in normal flow
    // pushes the container taller by the bar's height so callers need no padding hack.
    expect(screen.getByTestId('bulk-bar-spacer')).toBeInTheDocument();
  });

  it('renders no spacer when count is 0', () => {
    render(<BulkActionBar count={0} actions={[]} onClear={() => {}} testIdPrefix="quotes" />);
    expect(screen.queryByTestId('bulk-bar-spacer')).not.toBeInTheDocument();
  });
});
