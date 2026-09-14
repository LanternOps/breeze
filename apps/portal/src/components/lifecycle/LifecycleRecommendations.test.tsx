// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LifecycleRecommendations } from './LifecycleRecommendations';
import type { HardwareLifecycleOtherRow, HardwareLifecycleSummary } from '@breeze/shared';

function other(partial: Partial<HardwareLifecycleOtherRow> & { name: string }): HardwareLifecycleOtherRow {
  return { id: partial.name, kind: 'device', ...partial };
}

describe('LifecycleRecommendations', () => {
  it('renders each recommendation as a list item', () => {
    const summary: Pick<HardwareLifecycleSummary, 'recommendations' | 'other'> = {
      recommendations: ['Replace SAM4 before the school year starts', 'Renew warranty on LAW-SRV'],
      other: [],
    };

    const { container } = render(<LifecycleRecommendations summary={summary} />);

    const section = screen.getByTestId('lifecycle-recommendations');
    expect(section).toBeInTheDocument();
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(section).toHaveTextContent('Replace SAM4 before the school year starts');
    expect(section).toHaveTextContent('Renew warranty on LAW-SRV');
  });

  it('caps the other-equipment list and builds display names from manufacturer plus model', () => {
    const names = Array.from({ length: 10 }, (_, i) => other({ name: `Printer ${i}`, manufacturer: 'Brother', model: `MFC-${i}` }));
    const summary: Pick<HardwareLifecycleSummary, 'recommendations' | 'other'> = {
      recommendations: [],
      other: names,
    };

    render(<LifecycleRecommendations summary={summary} />);

    const equipment = screen.getByTestId('lifecycle-other-equipment');
    expect(equipment).toHaveTextContent('Brother MFC-0');
    expect(equipment).toHaveTextContent('2 more');
    expect(screen.queryByTestId('lifecycle-recommendations')).toBeNull();
  });

  it('falls back to the item name when manufacturer and model are missing', () => {
    const summary: Pick<HardwareLifecycleSummary, 'recommendations' | 'other'> = {
      recommendations: [],
      other: [other({ name: 'Unlabeled scanner' })],
    };

    render(<LifecycleRecommendations summary={summary} />);

    expect(screen.getByTestId('lifecycle-other-equipment')).toHaveTextContent('Unlabeled scanner');
  });
});
