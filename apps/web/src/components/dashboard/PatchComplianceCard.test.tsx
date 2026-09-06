import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const count = (opts as { count?: number } | undefined)?.count;
      return count !== undefined ? `${key}:${count}` : key;
    },
  }),
}));

import PatchComplianceCard from './PatchComplianceCard';
import type { DashboardQueryState } from '../../hooks/useDashboardQuery';
import type { PatchCompliance } from './types';

function loaded(data: PatchCompliance): DashboardQueryState<PatchCompliance> {
  return { data, error: null, isLoading: false, isFetching: false, unavailable: false, staleScope: false };
}

const basePatch: PatchCompliance = {
  summary: { total: 10, pending: 5, installed: 5, failed: 0, missing: 0, skipped: 0 },
  compliancePercent: 50,
  totalDevices: 3,
  compliantDevices: 1,
  criticalSummary: { total: 0, patched: 0, pending: 0 },
  importantSummary: { total: 0, patched: 0, pending: 0 },
  unratedSummary: { total: 0, patched: 0, pending: 0 },
};

describe('PatchComplianceCard', () => {
  it('shows an unrated-pending note when unratedSummary.pending > 0', () => {
    render(
      <PatchComplianceCard
        patch={loaded({
          ...basePatch,
          unratedSummary: { total: 4, patched: 0, pending: 4 },
        })}
      />
    );

    expect(screen.getByText('dashboard.patch.unratedPending:4')).toBeInTheDocument();
  });

  it('does not show the unrated-pending note when unratedSummary.pending is 0', () => {
    render(<PatchComplianceCard patch={loaded(basePatch)} />);

    expect(screen.queryByText(/unratedPending/)).not.toBeInTheDocument();
  });
});
