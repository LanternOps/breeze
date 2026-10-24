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

const viewerRef = vi.hoisted(() => ({
  current: {
    isPlatformAdmin: false,
    permissions: [{ resource: '*', action: '*' }],
    getScope: () => 'partner',
    toolSourcesEnabled: false,
    aiForOfficeEnabled: false,
    serviceManagementMode: 'native',
  } as unknown as import('../../lib/navVisibility').NavViewer,
}));
vi.mock('../../lib/navVisibility', async (orig) => ({
  ...(await orig<typeof import('../../lib/navVisibility')>()),
  useNavViewer: () => viewerRef.current,
}));

import PatchComplianceCard from './PatchComplianceCard';
import { parsePatchesHash } from '../patches/patchesHash';
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
  devicePercent: 33,
  failedDevices: 0,
  criticalSummary: { total: 0, patched: 0, pending: 0 },
  importantSummary: { total: 0, patched: 0, pending: 0 },
  unratedSummary: { total: 0, patched: 0, pending: 0 },
};

const hrefOf = (testId: string) => screen.getByTestId(testId).getAttribute('href');

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

  it('shows container images not checked next to the percentage when the API reports them (W06)', () => {
    render(<PatchComplianceCard patch={loaded({ ...basePatch, containerImages: { stale: 1, current: 2, unknown: 3 } })} />);
    expect(screen.getByText('dashboard.patch.imagesNotChecked:3')).toBeInTheDocument();
  });

  it('shows no image text without container images, or when every image was checked', () => {
    const { unmount } = render(<PatchComplianceCard patch={loaded(basePatch)} />);
    expect(screen.queryByText(/imagesNotChecked/)).not.toBeInTheDocument();
    unmount();
    render(<PatchComplianceCard patch={loaded({ ...basePatch, containerImages: { stale: 1, current: 2, unknown: 0 } })} />);
    expect(screen.queryByText(/imagesNotChecked/)).not.toBeInTheDocument();
  });
});

// #9791 C: the headline is the device percentage (Decision 4) and each patch
// number links to the filtered compliance list (count) or carries a named
// "affected" link when it counts patches rather than devices.
describe('PatchComplianceCard device % and links (#9791 C)', () => {
  it('headline renders devicePercent, not the item compliancePercent', () => {
    render(<PatchComplianceCard patch={loaded({ ...basePatch, compliancePercent: 80, devicePercent: 33 })} />);
    expect(screen.getByText('33%')).toBeInTheDocument();
    expect(screen.queryByText('80%')).toBeNull();
  });

  it('derives the device % from the counts when an older API omits devicePercent', () => {
    const { devicePercent: _omit, ...older } = basePatch;
    render(<PatchComplianceCard patch={loaded(older as PatchCompliance)} />);
    expect(screen.getByText('33%')).toBeInTheDocument();
  });

  it('compliant and non-compliant device counts link to their filtered lists', () => {
    render(<PatchComplianceCard patch={loaded(basePatch)} />);
    expect(parsePatchesHash(hrefOf('dashboard-patch-compliant-link')!.replace(/^\/patches/, ''))).toMatchObject({
      tab: 'compliance',
      status: 'compliant',
    });
    expect(hrefOf('dashboard-patch-compliant-link')).toBe('/patches#compliance&status=compliant');
    expect(hrefOf('dashboard-patch-noncompliant-link')).toBe('/patches#compliance&status=needs-patches');
    expect(screen.getByTestId('dashboard-patch-noncompliant-link')).toHaveTextContent('dashboard.patch.devicesNeedPatches:2');
  });

  it('pending, failed and critical patch counts carry named affected links', () => {
    render(
      <PatchComplianceCard
        patch={loaded({
          ...basePatch,
          summary: { ...basePatch.summary, failed: 2 },
          failedDevices: 1,
          criticalSummary: { total: 3, patched: 1, pending: 2 },
        })}
      />
    );
    expect(hrefOf('dashboard-patch-pending-devices-link')).toBe('/patches#compliance&status=needs-patches');
    expect(screen.getByTestId('dashboard-patch-pending-devices-link')).toHaveTextContent('dashboard.patch.viewPendingDevices');
    expect(hrefOf('dashboard-patch-failed-devices-link')).toBe('/patches#compliance&status=failed');
    expect(screen.getByTestId('dashboard-patch-failed-devices-link')).toHaveTextContent('dashboard.patch.viewFailedDevices');
    expect(hrefOf('dashboard-patch-critical-devices-link')).toBe('/patches#compliance&status=critical');
    expect(screen.getByTestId('dashboard-patch-critical-devices-link')).toHaveTextContent('dashboard.patch.viewCriticalDevices');
    // the numbers themselves stay text (they count patches, not devices)
    expect(screen.getByText('dashboard.patch.criticalPending:2').closest('a')).toBeNull();
  });

  it('hides the failed-devices link when no device has a failed install to show', () => {
    render(<PatchComplianceCard patch={loaded({ ...basePatch, summary: { ...basePatch.summary, failed: 2 }, failedDevices: 0 })} />);
    expect(screen.queryByTestId('dashboard-patch-failed-devices-link')).toBeNull();
  });

  it('every patch link has a resting underline and a focus-visible ring (#9033)', () => {
    render(
      <PatchComplianceCard
        patch={loaded({ ...basePatch, failedDevices: 1, criticalSummary: { total: 1, patched: 0, pending: 1 } })}
      />
    );
    for (const id of [
      'dashboard-patch-compliant-link',
      'dashboard-patch-noncompliant-link',
      'dashboard-patch-pending-devices-link',
      'dashboard-patch-failed-devices-link',
      'dashboard-patch-critical-devices-link',
    ]) {
      const cls = screen.getByTestId(id).className;
      expect(cls).toMatch(/(^|\s)underline(\s|$)/);
      expect(cls).toMatch(/focus-visible:ring/);
    }
  });

  it('a viewer without devices:read sees the numbers as plain text (R4)', () => {
    const saved = viewerRef.current;
    viewerRef.current = { ...saved, permissions: [{ resource: 'alerts', action: 'read' }] } as typeof saved;
    try {
      render(<PatchComplianceCard patch={loaded({ ...basePatch, failedDevices: 1 })} />);
      expect(screen.queryByTestId('dashboard-patch-compliant-link')).toBeNull();
      expect(screen.queryByTestId('dashboard-patch-failed-devices-link')).toBeNull();
      expect(screen.getByText('33%')).toBeInTheDocument();
    } finally {
      viewerRef.current = saved;
    }
  });

  it('an empty fleet shows the empty state, not 0% or 100% of nothing', () => {
    render(
      <PatchComplianceCard
        patch={loaded({ ...basePatch, compliancePercent: 100, devicePercent: 0, totalDevices: 0, compliantDevices: 0, summary: { total: 0, pending: 0, installed: 0, failed: 0, missing: 0, skipped: 0 } })}
      />
    );
    expect(screen.getByText('dashboard.patch.empty')).toBeInTheDocument();
    expect(screen.queryByText(/%/)).toBeNull();
  });
});
