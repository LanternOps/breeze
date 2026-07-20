// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { SegmentedControl } from './SegmentedControl';

const opts = [
  { key: 'search', label: 'Search' },
  { key: 'browse', label: 'Browse' },
];

it('renders options, marks active, fires onChange', () => {
  const onChange = vi.fn();
  render(<SegmentedControl options={opts} value="search" onChange={onChange} />);
  expect(screen.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('tab', { name: 'Browse' }));
  expect(onChange).toHaveBeenCalledWith('browse');
});

it('moves selection with arrow keys', () => {
  const onChange = vi.fn();
  render(<SegmentedControl options={opts} value="search" onChange={onChange} />);
  fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
  expect(onChange).toHaveBeenCalledWith('browse');
});
