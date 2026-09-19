import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import { RollupBand, type RollupCell } from './RollupBand';

function cells(overrides: Partial<Record<RollupCell['key'], Partial<RollupCell>>> = {}): RollupCell[] {
  const make = (key: RollupCell['key'], count: number | null): RollupCell => ({ key, count, pressed: false, onPress: vi.fn(), ...overrides[key] });
  return [make('all', 12), make('setupIncomplete', 3), make('accountMissing', 5), make('openTickets', 2)];
}

describe('RollupBand', () => {
  it('renders one aria-pressed button per cell with its count and applies the filter on press', () => {
    const onPress = vi.fn();
    render(<RollupBand cells={cells({ setupIncomplete: { pressed: true, onPress } })} status="ready" onRetry={() => undefined} />);
    expect(screen.getByTestId('org-board-band-all-count')).toHaveTextContent('12');
    expect(screen.getByTestId('org-board-band-setupIncomplete')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('org-board-band-all')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /Setup incomplete/ })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('org-board-band-setupIncomplete'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('shows dashes for counts that have not landed and no partial line while loading', () => {
    render(<RollupBand cells={cells({ setupIncomplete: { count: null }, openTickets: { count: null } })} status="loading" onRetry={() => undefined} />);
    expect(screen.getByTestId('org-board-band-setupIncomplete-count')).toHaveTextContent('—');
    expect(screen.getByTestId('org-board-band-all-count')).toHaveTextContent('12');
    expect(screen.queryByTestId('org-board-band-partial')).not.toBeInTheDocument();
  });

  it('renders sub-lines in the requested tone', () => {
    render(<RollupBand cells={cells({ all: { sub: '2 trial · 1 suspended' }, openTickets: { sub: '1 SLA breached', subTone: 'destructive' } })} status="ready" onRetry={() => undefined} />);
    expect(screen.getByText('2 trial · 1 suspended').className).toContain('text-muted-foreground');
    expect(screen.getByText('1 SLA breached').className).toContain('text-destructive');
  });

  it('says partial with a Try again action when a batch failed', () => {
    const onRetry = vi.fn();
    render(<RollupBand cells={cells()} status="partial" onRetry={onRetry} />);
    expect(screen.getByTestId('org-board-band-partial')).toHaveTextContent('Some organizations could not be checked.');
    fireEvent.click(screen.getByTestId('org-board-band-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
