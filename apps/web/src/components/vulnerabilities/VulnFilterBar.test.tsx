import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@/lib/i18n';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { VulnFilterBar } from './VulnFilterBar';
import type { VulnFleetFilters } from '../../lib/api/vulnerabilities';

const FILTERS: VulnFleetFilters = { search: '', severity: '', status: 'open', kevOnly: false, patchAvailable: false };

describe('VulnFilterBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces search typing: one onChange after the pause, not one per keystroke', () => {
    const onChange = vi.fn();
    render(<VulnFilterBar filters={FILTERS} onChange={onChange} />);
    const input = screen.getByTestId('vuln-filter-search');

    fireEvent.change(input, { target: { value: 'c' } });
    fireEvent.change(input, { target: { value: 'ch' } });
    fireEvent.change(input, { target: { value: 'chrome' } });
    // Input echoes immediately, but nothing has been committed yet.
    expect(input).toHaveValue('chrome');
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ search: 'chrome' }));
  });

  it('applies an emptied search box immediately (clearing feels instant)', () => {
    const onChange = vi.fn();
    render(<VulnFilterBar filters={{ ...FILTERS, search: 'chrome' }} onChange={onChange} />);
    fireEvent.change(screen.getByTestId('vuln-filter-search'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ search: '' }));
  });

  it('keeps non-text controls immediate: severity/status/checkboxes fire onChange at once', () => {
    const onChange = vi.fn();
    render(<VulnFilterBar filters={FILTERS} onChange={onChange} />);

    fireEvent.change(screen.getByTestId('vuln-filter-severity'), { target: { value: 'high' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ severity: 'high' }));

    fireEvent.click(screen.getByTestId('vuln-filter-kev'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ kevOnly: true }));

    fireEvent.change(screen.getByTestId('vuln-filter-status'), { target: { value: 'accepted' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'accepted', expiringWithinDays: undefined }),
    );
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('a commit carries the latest non-search filters, not a stale snapshot', () => {
    const onChange = vi.fn();
    const { rerender } = render(<VulnFilterBar filters={FILTERS} onChange={onChange} />);
    fireEvent.change(screen.getByTestId('vuln-filter-search'), { target: { value: 'zoom' } });
    // Severity changes (and the parent re-renders with new filters) before the debounce fires.
    rerender(<VulnFilterBar filters={{ ...FILTERS, severity: 'critical' }} onChange={onChange} />);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ search: 'zoom', severity: 'critical' }));
  });

  it('keeps the search placeholder honest per tab (CVE endpoint only matches CVE ids)', () => {
    const { rerender } = render(<VulnFilterBar filters={FILTERS} onChange={() => {}} searchScope="software" />);
    expect(screen.getByTestId('vuln-filter-search')).toHaveAttribute('placeholder', 'Search software or CVE…');
    rerender(<VulnFilterBar filters={FILTERS} onChange={() => {}} searchScope="cves" />);
    expect(screen.getByTestId('vuln-filter-search')).toHaveAttribute('placeholder', 'Search CVE id…');
  });

  it('syncs the box when the parent resets filters externally', () => {
    const onChange = vi.fn();
    const { rerender } = render(<VulnFilterBar filters={{ ...FILTERS, search: 'chrome' }} onChange={onChange} />);
    expect(screen.getByTestId('vuln-filter-search')).toHaveValue('chrome');
    rerender(<VulnFilterBar filters={FILTERS} onChange={onChange} />);
    expect(screen.getByTestId('vuln-filter-search')).toHaveValue('');
  });
});
