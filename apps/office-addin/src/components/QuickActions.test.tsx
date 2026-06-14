import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import { QuickActions } from './QuickActions';
import type { WorkbookContext } from '../api/types';

afterEach(cleanup);

function captureReturning(ctx: WorkbookContext | undefined) {
  return vi.fn(async () => ctx);
}

describe('QuickActions', () => {
  it('renders generic chips when there is no selection', async () => {
    render(<QuickActions capture={captureReturning(undefined)} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('quickaction-summarize-sheet')).toBeTruthy());
    expect(screen.getByTestId('quickaction-what-can-you-do')).toBeTruthy();
  });

  it('renders explain-formula for a single formula cell', async () => {
    const ctx: WorkbookContext = { kind: 'selection', address: 'B2', cells: [['=SUM(A1:A10)']] };
    render(<QuickActions capture={captureReturning(ctx)} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('quickaction-explain-formula')).toBeTruthy());
  });

  it('renders summarize + chart chips for a numeric range', async () => {
    const ctx: WorkbookContext = {
      kind: 'selection',
      address: 'A1:B2',
      cells: [
        [1, 2],
        [3, 4],
      ],
    };
    render(<QuickActions capture={captureReturning(ctx)} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('quickaction-summarize-data')).toBeTruthy());
    expect(screen.getByTestId('quickaction-make-chart')).toBeTruthy();
  });

  it('calls onSelect with the canned prompt when a chip is clicked', async () => {
    const ctx: WorkbookContext = { kind: 'selection', address: 'B2', cells: [['=A1*2']] };
    const onSelect = vi.fn();
    render(<QuickActions capture={captureReturning(ctx)} onSelect={onSelect} />);
    const chip = await screen.findByTestId('quickaction-explain-formula');
    fireEvent.click(chip);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]).toContain('formula');
  });

  it('falls back to generic chips when capture rejects', async () => {
    const capture = vi.fn(async () => {
      throw new Error('Office unavailable');
    });
    render(<QuickActions capture={capture} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('quickaction-summarize-sheet')).toBeTruthy());
  });
});
