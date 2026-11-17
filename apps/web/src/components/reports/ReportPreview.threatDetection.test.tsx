// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import ReportPreview from './ReportPreview';

/**
 * The in-app staff preview for the Threat Detection Review (#5784 W02).
 *
 * This surface carries its OWN implementation of the "unmeasured is not zero"
 * rule — the PDF renderer, the shared utils and the API generator each have
 * theirs, and this is the one a technician actually looks at before delivering
 * the occurrence. A regression here (for example a falsy check in place of the
 * null check) would turn a genuine `0` into "not measured", or worse show `0`
 * for a source that was never connected, with nothing else failing.
 */

const COVERAGE_NOTE =
  'Huntress is not connected for this partner, so threat detection was not measured for this period.';

function previewData(summary: Record<string, unknown>) {
  return {
    type: 'threat_detection_review' as never,
    format: 'pdf',
    generatedAt: '2026-09-30T05:18:00.000Z',
    data: { rows: [], rowCount: 0, summary },
  };
}

const MEASURED = {
  coverage: {
    periodStart: '2026-09-01', periodEnd: '2026-09-30',
    sourceStatus: 'ok', note: '',
  },
  agentCoverage: { huntressAgents: 41, breezeDevices: 43, agentsOffline: 2, devicesWithoutAgent: 2 },
  incidents: {
    opened: 3, resolved: 2, bySeverity: { critical: 1 }, byStatus: { open: 1 },
    meanResolveHours: 4.5, medianResolveHours: 3, carriedIn: 1,
  },
  rows: [],
  dataGaps: [],
};

const UNMEASURED = {
  coverage: { periodStart: '2026-09-01', periodEnd: '2026-09-30', sourceStatus: 'not_connected', note: COVERAGE_NOTE },
  agentCoverage: { huntressAgents: null, breezeDevices: 43, agentsOffline: null, devicesWithoutAgent: null },
  incidents: {
    opened: null, resolved: null, bySeverity: null, byStatus: null,
    meanResolveHours: null, medianResolveHours: null, carriedIn: null,
  },
  rows: [],
  dataGaps: [COVERAGE_NOTE],
};

describe('ReportPreview: threat_detection_review', () => {
  it('renders the designed tiles instead of the generic summary cards', () => {
    render(<ReportPreview data={previewData(MEASURED)} timezone="UTC" />);
    const panel = screen.getByTestId('threat-detection-summary');
    expect(panel).toBeInTheDocument();
    // The generic key/value cards must not also render — the summary carries
    // nested objects that would print as "[object Object]".
    expect(within(panel).getByText('3')).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });

  it('shows a measured zero as 0, not as not-measured', () => {
    render(<ReportPreview
      data={previewData({ ...MEASURED, incidents: { ...MEASURED.incidents, opened: 0, resolved: 0, carriedIn: 0 } })}
      timezone="UTC"
    />);
    const panel = screen.getByTestId('threat-detection-summary');
    expect(within(panel).getAllByText('0').length).toBeGreaterThanOrEqual(3);
    expect(within(panel).queryByText('N/A')).toBeNull();
  });

  it('shows an unmeasured count as N/A and never as zero', () => {
    render(<ReportPreview data={previewData(UNMEASURED)} timezone="UTC" />);
    const panel = screen.getByTestId('threat-detection-summary');
    expect(within(panel).getAllByText('N/A').length).toBeGreaterThanOrEqual(4);
    // Breeze's own fleet count IS measured and stays a real number.
    expect(within(panel).getByText('43')).toBeInTheDocument();
    expect(within(panel).queryByText('0')).toBeNull();
  });

  it('surfaces the coverage gap prominently when one exists', () => {
    render(<ReportPreview data={previewData(UNMEASURED)} timezone="UTC" />);
    const note = screen.getByTestId('threat-detection-coverage-note');
    expect(note).toHaveTextContent(/not connected/i);
    expect(note).not.toHaveTextContent(/\bno incidents\b/i);
  });

  // #12046: "8 endpoints with an agent / 12 managed / 8 without" did not add
  // up — the first tile counted agents (matched or not), not devices.
  it('shows device coverage tiles that add up to the managed count', () => {
    render(<ReportPreview
      data={previewData({
        ...MEASURED,
        agentCoverage: {
          huntressAgents: 8, breezeDevices: 12, agentsOffline: 0, devicesWithoutAgent: 8,
          devicesWithDetectionAgent: 7, devicesWithoutDetectionAgent: 5, unmatchedAgents: 4,
        },
      })}
      timezone="UTC"
    />);
    const panel = screen.getByTestId('threat-detection-summary');
    expect(within(panel).queryByText('Endpoints with a detection agent')).toBeNull();
    const valueOf = (label: string) => within(panel).getByText(label).nextElementSibling?.textContent;
    expect(valueOf('Devices Breeze manages')).toBe('12');
    expect(valueOf('Managed devices with a detection agent')).toBe('7');
    expect(valueOf('Managed devices with no detection agent')).toBe('5');
  });

  it('derives a reconciling pair from a legacy snapshot, and keeps unmeasured tiles N/A', () => {
    const { unmount } = render(<ReportPreview data={previewData(MEASURED)} timezone="UTC" />);
    let panel = screen.getByTestId('threat-detection-summary');
    const valueOf = (label: string) => within(panel).getByText(label).nextElementSibling?.textContent;
    // 43 managed, 2 without a (Huntress) agent → 41 with.
    expect(valueOf('Managed devices with a detection agent')).toBe('41');
    expect(valueOf('Managed devices with no detection agent')).toBe('2');
    unmount();

    render(<ReportPreview data={previewData(UNMEASURED)} timezone="UTC" />);
    panel = screen.getByTestId('threat-detection-summary');
    expect(valueOf('Managed devices with a detection agent')).toBe('N/A');
    expect(valueOf('Managed devices with no detection agent')).toBe('N/A');
  });

  it('omits the coverage panel entirely when nothing is missing', () => {
    render(<ReportPreview data={previewData(MEASURED)} timezone="UTC" />);
    expect(screen.queryByTestId('threat-detection-coverage-note')).toBeNull();
  });
});
