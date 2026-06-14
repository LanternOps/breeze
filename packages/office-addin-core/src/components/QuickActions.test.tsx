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

  it('uses the host-supplied compute function when provided (not the Excel default)', async () => {
    const ctx: WorkbookContext = { kind: 'selection', text: 'a doc paragraph' };
    const compute = vi.fn(() => [
      { id: 'summarize-document', label: 'Summarize this document', prompt: 'Summarize this document.' },
    ]);
    render(<QuickActions capture={captureReturning(ctx)} compute={compute} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('quickaction-summarize-document')).toBeTruthy());
    // The host function was handed the captured context...
    expect(compute).toHaveBeenCalledWith(ctx);
    // ...and the Excel grid chips are NOT rendered.
    expect(screen.queryByTestId('quickaction-summarize-sheet')).toBeNull();
  });

  it('calls the host compute with undefined when capture rejects', async () => {
    const compute = vi.fn(() => [
      { id: 'draft-reply', label: 'Draft a reply', prompt: 'Draft a reply to this email.' },
    ]);
    const capture = vi.fn(async () => {
      throw new Error('mailbox unavailable');
    });
    render(<QuickActions capture={capture} compute={compute} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('quickaction-draft-reply')).toBeTruthy());
    expect(compute).toHaveBeenCalledWith(undefined);
  });

  it('uses the Excel grid default when no compute is supplied', async () => {
    const ctx: WorkbookContext = { kind: 'selection', address: 'B2', cells: [['=SUM(A1:A10)']] };
    render(<QuickActions capture={captureReturning(ctx)} onSelect={() => {}} />);
    // The default path classifies the grid shape → formula chip.
    await waitFor(() => expect(screen.getByTestId('quickaction-explain-formula')).toBeTruthy());
  });
});
