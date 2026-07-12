import { describe, it, expect, vi } from 'vitest';
import '@/lib/i18n';
import { render, screen, fireEvent } from '@testing-library/react';

import {
  DEFAULT_FILTERS,
  isDefaultVulnFilters,
  resolveVulnEmptyVariant,
  VulnEmptyState,
} from './VulnEmptyState';
import type { FleetVulnStats } from '../../lib/api/vulnerabilities';

function stats(overrides: Partial<FleetVulnStats> = {}): FleetVulnStats {
  return {
    criticalOpen: 0,
    kevCveCount: 0,
    kevDeviceCount: 0,
    patchReadyFindingCount: 0,
    acceptedExpiringSoon: 0,
    totalFindings: 0,
    lastDetectedAt: null,
    ...overrides,
  };
}

describe('isDefaultVulnFilters', () => {
  it('accepts the exact default filter set', () => {
    expect(isDefaultVulnFilters({ ...DEFAULT_FILTERS })).toBe(true);
  });

  it.each([
    ['search', { search: 'chrome' }],
    ['severity', { severity: 'critical' }],
    ['status accepted', { status: 'accepted' }],
    ['status all', { status: 'all' }],
    ['kevOnly', { kevOnly: true }],
    ['patchAvailable', { patchAvailable: true }],
    ['expiringWithinDays', { expiringWithinDays: 14 }],
  ] as const)('flags %s as non-default', (_label, override) => {
    expect(isDefaultVulnFilters({ ...DEFAULT_FILTERS, ...override })).toBe(false);
  });
});

describe('resolveVulnEmptyVariant', () => {
  it('is "filtered" whenever any non-default filter is active, regardless of stats', () => {
    expect(resolveVulnEmptyVariant({ ...DEFAULT_FILTERS, severity: 'low' }, stats({ totalFindings: 9 }))).toBe('filtered');
    expect(resolveVulnEmptyVariant({ ...DEFAULT_FILTERS, status: 'accepted' }, null)).toBe('filtered');
  });

  it('is "clean" with default filters when scanning has produced findings before', () => {
    expect(resolveVulnEmptyVariant({ ...DEFAULT_FILTERS }, stats({ totalFindings: 3 }))).toBe('clean');
  });

  it('is "unscanned" with default filters when no finding has ever existed', () => {
    expect(resolveVulnEmptyVariant({ ...DEFAULT_FILTERS }, stats({ totalFindings: 0 }))).toBe('unscanned');
  });

  it('is "unknown" with default filters when stats are unavailable', () => {
    expect(resolveVulnEmptyVariant({ ...DEFAULT_FILTERS }, null)).toBe('unknown');
  });
});

describe('VulnEmptyState', () => {
  const baseProps = {
    onClearFilters: () => {},
    containerTestId: 'vulnerability-table-empty',
    clearFiltersTestId: 'vulnerability-clear-filters',
  };

  it('filtered: names the filters as the reason and wires Clear filters', () => {
    const onClear = vi.fn();
    render(<VulnEmptyState {...baseProps} variant="filtered" onClearFilters={onClear} />);
    expect(screen.getByTestId('vuln-empty-filtered')).toHaveTextContent('No vulnerabilities match the current filters.');
    fireEvent.click(screen.getByTestId('vulnerability-clear-filters'));
    expect(onClear).toHaveBeenCalled();
    expect(screen.getByTestId('vulnerability-table-empty')).toBeInTheDocument();
  });

  it('clean: calm positive state with last-detection context, no clear-filters action', () => {
    render(<VulnEmptyState {...baseProps} variant="clean" lastDetectedAt="2026-06-30T12:00:00.000Z" />);
    const el = screen.getByTestId('vuln-empty-clean');
    expect(el).toHaveTextContent('No open vulnerabilities across your fleet');
    expect(el).toHaveTextContent('Last finding detected');
    expect(screen.queryByTestId('vulnerability-clear-filters')).toBeNull();
  });

  it('clean: omits the last-detection line when the timestamp is missing', () => {
    render(<VulnEmptyState {...baseProps} variant="clean" lastDetectedAt={null} />);
    expect(screen.getByTestId('vuln-empty-clean')).not.toHaveTextContent('Last finding detected');
  });

  it('unscanned: teaches what appears here and links to configuration policies', () => {
    render(<VulnEmptyState {...baseProps} variant="unscanned" />);
    const el = screen.getByTestId('vuln-empty-unscanned');
    expect(el).toHaveTextContent('No vulnerability findings yet');
    expect(el).toHaveTextContent('configuration policy');
    const link = screen.getByTestId('vuln-empty-setup-link');
    expect(link).toHaveAttribute('href', '/configuration-policies');
  });

  it('unknown: stays neutral when stats are unavailable', () => {
    render(<VulnEmptyState {...baseProps} variant="unknown" />);
    expect(screen.getByTestId('vuln-empty-unknown')).toHaveTextContent('No vulnerabilities to show.');
    expect(screen.queryByTestId('vuln-empty-clean')).toBeNull();
    expect(screen.queryByTestId('vuln-empty-unscanned')).toBeNull();
  });
});
