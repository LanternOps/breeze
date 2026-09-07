import '@/lib/i18n';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BulkPurgeDialog } from './BulkPurgeDialog';

afterEach(cleanup);

function targets(n: number, orgId: string | null = 'org-1') {
  return Array.from({ length: n }, (_v, i) => ({ hostname: `host-${i + 1}`, orgId }));
}

describe('BulkPurgeDialog (#2787)', () => {
  it('keeps Confirm inert until the exact device count is typed', () => {
    const onConfirm = vi.fn();
    render(
      <BulkPurgeDialog open targets={targets(3)} onClose={vi.fn()} onConfirm={onConfirm} />,
    );

    const confirm = screen.getByTestId('confirm-bulk-purge');
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(confirm).toHaveAttribute('aria-disabled', 'true');

    // A wrong number must not arm it — otherwise "type something" is the gate,
    // which any stray keystroke passes.
    fireEvent.change(screen.getByTestId('bulk-purge-count'), { target: { value: '2' } });
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('bulk-purge-count'), { target: { value: '3' } });
    expect(confirm).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('lists the first five hostnames and collapses the rest', () => {
    render(<BulkPurgeDialog open targets={targets(8)} onClose={vi.fn()} onConfirm={vi.fn()} />);

    const list = screen.getByTestId('bulk-purge-targets');
    expect(list.textContent).toContain('host-1');
    expect(list.textContent).toContain('host-5');
    expect(list.textContent).not.toContain('host-6');
    expect(list.textContent).toMatch(/3 more/);
  });

  it('names every host when there are five or fewer, with no "more" line', () => {
    render(<BulkPurgeDialog open targets={targets(2)} onClose={vi.fn()} onConfirm={vi.fn()} />);
    const list = screen.getByTestId('bulk-purge-targets');
    expect(list.textContent).toContain('host-1');
    expect(list.textContent).toContain('host-2');
    expect(list.textContent).not.toMatch(/more/);
  });

  it('warns when the selection spans more than one organization', () => {
    render(
      <BulkPurgeDialog
        open
        targets={[
          { hostname: 'a', orgId: 'org-1' },
          { hostname: 'b', orgId: 'org-2' },
        ]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByTestId('bulk-purge-org-warning')).toBeInTheDocument();
  });

  it('does not warn for a single-organization selection', () => {
    render(<BulkPurgeDialog open targets={targets(3)} onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.queryByTestId('bulk-purge-org-warning')).not.toBeInTheDocument();
  });

  /**
   * A count left over from a previous opening would arm Confirm for a
   * DIFFERENT selection on the next open — the typed-count gate defeated by
   * the component's own state.
   */
  it('clears the typed count when the dialog reopens on a new selection', () => {
    const onConfirm = vi.fn();
    const view = render(
      <BulkPurgeDialog open targets={targets(3)} onClose={vi.fn()} onConfirm={onConfirm} />,
    );
    fireEvent.change(screen.getByTestId('bulk-purge-count'), { target: { value: '3' } });
    expect(screen.getByTestId('confirm-bulk-purge')).toHaveAttribute('aria-disabled', 'false');

    view.rerender(
      <BulkPurgeDialog open={false} targets={targets(3)} onClose={vi.fn()} onConfirm={onConfirm} />,
    );
    view.rerender(
      <BulkPurgeDialog open targets={targets(3)} onClose={vi.fn()} onConfirm={onConfirm} />,
    );

    expect(screen.getByTestId('bulk-purge-count')).toHaveValue('');
    expect(screen.getByTestId('confirm-bulk-purge')).toHaveAttribute('aria-disabled', 'true');
  });
});
