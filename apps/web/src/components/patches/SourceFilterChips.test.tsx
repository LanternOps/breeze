import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SourceFilterChips from './SourceFilterChips';

describe('SourceFilterChips', () => {
  it('renders one chip per source plus an "All" chip with the summed total', () => {
    render(
      <SourceFilterChips
        counts={{ microsoft: 3, apple: 2, linux: 1, third_party: 4, custom: 0 }}
        value="all"
        onChange={() => {}}
      />
    );

    expect(screen.getByTestId('patches-filter-all')).toBeTruthy();
    expect(screen.getByTestId('patches-filter-microsoft')).toBeTruthy();
    expect(screen.getByTestId('patches-filter-apple')).toBeTruthy();
    expect(screen.getByTestId('patches-filter-linux')).toBeTruthy();
    expect(screen.getByTestId('patches-filter-third_party')).toBeTruthy();

    expect(screen.getByTestId('patches-count-all').textContent).toContain('10');
    expect(screen.getByTestId('patches-count-microsoft').textContent).toContain('3');
    expect(screen.getByTestId('patches-count-third_party').textContent).toContain('4');
  });

  it('fires onChange with the clicked source', () => {
    const onChange = vi.fn();
    render(
      <SourceFilterChips
        counts={{ microsoft: 3, apple: 2, linux: 1, third_party: 4, custom: 0 }}
        value="all"
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByTestId('patches-filter-third_party'));
    expect(onChange).toHaveBeenCalledWith('third_party');

    fireEvent.click(screen.getByTestId('patches-filter-microsoft'));
    expect(onChange).toHaveBeenCalledWith('microsoft');
  });
});
