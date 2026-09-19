import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@/lib/i18n';
import { RollupBand, type RollupCell } from './RollupBand';

function cells(overrides: Partial<Record<RollupCell['key'], Partial<RollupCell>>> = {}): RollupCell[] {
  const make = (key: RollupCell['key'], count: number | null): RollupCell => ({ key, count, pressed: false, onPress: vi.fn(), ...overrides[key] });
  return [make('all', 12), make('setupIncomplete', 3), make('accountMissing', 2), make('unlinked', 4), make('openTickets', 5)];
}

describe('RollupBand — W03', () => {
  it('renders the Unlinked cell as a filter button with its count and label', () => {
    const onPress = vi.fn();
    render(<RollupBand cells={cells({ unlinked: { onPress } })} status="ready" onRetry={() => undefined} connectors={[]} />);
    const cell = screen.getByTestId('org-board-band-unlinked');
    expect(cell).toHaveTextContent('Unlinked');
    expect(screen.getByTestId('org-board-band-unlinked-count')).toHaveTextContent('4');
    expect(cell).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(cell);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders one repair line per connector that is not connected, linking to its settings tab', () => {
    render(
      <RollupBand
        cells={cells()}
        status="ready"
        onRetry={() => undefined}
        connectors={[
          { system: 'quickbooks', state: 'reauth_required' },
          { system: 'psa', state: 'disabled', provider: 'autotask' },
          { system: 'pax8', state: 'connected' },
        ]}
      />,
    );
    const qbo = screen.getByTestId('org-board-repair-quickbooks');
    expect(qbo).toHaveTextContent('QuickBooks needs reconnecting');
    expect(qbo).toHaveAttribute('href', '/integrations#quickbooks');
    expect(qbo).toHaveAttribute('aria-label', 'Open QuickBooks settings');
    const psa = screen.getByTestId('org-board-repair-psa');
    expect(psa).toHaveTextContent('Autotask connector is disabled');
    expect(psa).toHaveAttribute('href', '/integrations/psa');
    expect(screen.queryByTestId('org-board-repair-pax8')).not.toBeInTheDocument();
  });

  it('renders no repair region when every connector is connected, or before connectors are known', () => {
    const { rerender } = render(<RollupBand cells={cells()} status="ready" onRetry={() => undefined} connectors={[{ system: 'pax8', state: 'connected' }]} />);
    expect(screen.queryByTestId('org-board-repairs')).not.toBeInTheDocument();
    rerender(<RollupBand cells={cells()} status="loading" onRetry={() => undefined} connectors={null} />);
    expect(screen.queryByTestId('org-board-repairs')).not.toBeInTheDocument();
  });
});
