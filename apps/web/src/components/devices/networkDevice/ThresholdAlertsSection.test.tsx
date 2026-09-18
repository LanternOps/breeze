import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ThresholdAlertsSection } from './ThresholdAlertsSection';
import type { Collection } from './types';
import type { ThresholdSummary } from './useAssetMonitoring';

const threshold: ThresholdSummary = { id: 'toner', oid: '1.3.6.1.2.1.43.11.1', operator: 'lt', threshold: '10', severity: 'high', message: null, isActive: false };
const collection: Collection = { templateId: 'printer', lastPolledAt: null, pollingInterval: 300, status: 'ok', consecutiveFailures: 0,
  oids: [
    { baseOid: '1.3.6.1.2.1.43', name: 'Printer', mode: 'walk', cadence: 'fast', state: 'collecting', observedAt: null, instances: [], error: null },
    { baseOid: '1.3.6.1.2.1.43.11', name: 'Toner level', mode: 'walk', cadence: 'fast', state: 'collecting', observedAt: null, instances: [], error: null },
  ],
};

describe('ThresholdAlertsSection', () => {
  it('uses the longest OID prefix, translated severity and Disabled state', () => {
    render(<ThresholdAlertsSection thresholds={[threshold]} collection={collection} />);
    const row = screen.getByTestId('network-detail-threshold-toner');
    expect(row).toHaveTextContent('Toner level');
    expect(row).not.toHaveTextContent('Printer');
    expect(row).toHaveTextContent('High');
    expect(row).not.toHaveTextContent('severity.high');
    expect(row).toHaveTextContent('Disabled');
  });
  it('falls back to the raw OID', () => {
    render(<ThresholdAlertsSection thresholds={[threshold]} collection={null} />);
    expect(screen.getByTestId('network-detail-threshold-toner')).toHaveTextContent(threshold.oid);
  });
  it('shows failure and retry instead of the empty state', async () => {
    const onRetry = vi.fn();
    render(<ThresholdAlertsSection thresholds={[]} collection={null} thresholdsError onRetry={onRetry} />);
    expect(screen.queryByTestId('network-detail-thresholds-empty')).toBeNull();
    expect(screen.getByTestId('network-detail-thresholds-error')).toHaveClass('text-destructive');
    await userEvent.click(screen.getByTestId('network-detail-thresholds-retry'));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
