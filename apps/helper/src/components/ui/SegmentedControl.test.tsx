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

const three = [
  { key: 'a', label: 'A' },
  { key: 'b', label: 'B' },
  { key: 'c', label: 'C' },
];

describe('roving tabindex + keyboard navigation', () => {
  it('only the selected tab is in the tab order; tablist is not focusable', () => {
    render(<SegmentedControl options={three} value="b" onChange={vi.fn()} />);
    expect(screen.getByRole('tablist')).not.toHaveAttribute('tabindex');
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'C' })).toHaveAttribute('tabindex', '-1');
  });

  it('falls back to the first tab in the tab order when value matches nothing', () => {
    render(<SegmentedControl options={three} value="zzz" onChange={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('tabindex', '-1');
  });

  it('ArrowRight selects and focuses the next tab', () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={three} value="a" onChange={onChange} />);
    const a = screen.getByRole('tab', { name: 'A' });
    a.focus();
    fireEvent.keyDown(a, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.getByRole('tab', { name: 'B' })).toHaveFocus();
  });

  it('ArrowLeft selects and focuses the previous tab', () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={three} value="b" onChange={onChange} />);
    const b = screen.getByRole('tab', { name: 'B' });
    b.focus();
    fireEvent.keyDown(b, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('a');
    expect(screen.getByRole('tab', { name: 'A' })).toHaveFocus();
  });

  it('wraps around at the ends', () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={three} value="c" onChange={onChange} />);
    const c = screen.getByRole('tab', { name: 'C' });
    c.focus();
    fireEvent.keyDown(c, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('a');
    expect(screen.getByRole('tab', { name: 'A' })).toHaveFocus();
  });

  it('Home and End jump to first and last', () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={three} value="b" onChange={onChange} />);
    const b = screen.getByRole('tab', { name: 'B' });
    b.focus();
    fireEvent.keyDown(b, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('c');
    expect(screen.getByRole('tab', { name: 'C' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'C' }), { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('a');
    expect(screen.getByRole('tab', { name: 'A' })).toHaveFocus();
  });

  it('ignores unrelated keys', () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={three} value="a" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'A' }), { key: 'Tab' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
