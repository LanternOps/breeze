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
});
