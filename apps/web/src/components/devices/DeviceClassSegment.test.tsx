import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DeviceClassSegment } from './DeviceClassSegment';

describe('DeviceClassSegment', () => {
  const counts = { all: 15, agent: 10, network: 2, manual: 3 };

  it('renders the four segments with their counts', () => {
    render(<DeviceClassSegment value="all" counts={counts} onChange={() => {}} />);
    expect(screen.getByTestId('device-class-segment-all')).toHaveTextContent('All');
    expect(screen.getByTestId('device-class-segment-all')).toHaveTextContent('15');
    expect(screen.getByTestId('device-class-segment-agent')).toHaveTextContent('10');
    expect(screen.getByTestId('device-class-segment-network')).toHaveTextContent('2');
    expect(screen.getByTestId('device-class-segment-manual')).toHaveTextContent('3');
  });

  it('marks the active segment as pressed', () => {
    render(<DeviceClassSegment value="network" counts={counts} onChange={() => {}} />);
    expect(screen.getByTestId('device-class-segment-network')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('device-class-segment-agent')).toHaveAttribute('aria-pressed', 'false');
  });

  it('emits onChange with the chosen class', () => {
    const onChange = vi.fn();
    render(<DeviceClassSegment value="all" counts={counts} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('device-class-segment-network'));
    expect(onChange).toHaveBeenCalledWith('network');
  });

  // #7148: at 390px this 4-segment row overflowed and the 4th segment ("Manual")
  // was cut to "M". Labels collapse to icon-only below `sm`, kept accessible
  // via aria-label since the hidden label text is excluded from the a11y tree.
  it('collapses labels to icon-only below sm, with an accessible name on every button', () => {
    render(<DeviceClassSegment value="all" counts={counts} onChange={() => {}} />);
    for (const id of ['all', 'agent', 'network', 'manual']) {
      const btn = screen.getByTestId(`device-class-segment-${id}`);
      expect(btn).toHaveAttribute('aria-label');
      const label = btn.querySelector('span.hidden.sm\\:inline');
      expect(label).not.toBeNull();
      expect(label?.textContent).toBe(btn.getAttribute('aria-label'));
    }
  });
});
