import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DeviceClassSegment } from './DeviceClassSegment';

describe('DeviceClassSegment', () => {
  const counts = { all: 12, agent: 10, network: 2 };

  it('renders the three segments with their counts', () => {
    render(<DeviceClassSegment value="all" counts={counts} onChange={() => {}} />);
    expect(screen.getByTestId('device-class-segment-all')).toHaveTextContent('All');
    expect(screen.getByTestId('device-class-segment-all')).toHaveTextContent('12');
    expect(screen.getByTestId('device-class-segment-agent')).toHaveTextContent('10');
    expect(screen.getByTestId('device-class-segment-network')).toHaveTextContent('2');
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
});
