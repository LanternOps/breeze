import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The unsaved-changes flag (#12469) through real tabs and the real
// useFeatureLink: only fetchWithAuth and the toast are stubbed. One tab of each
// save style: HardwareMonitoringTab passes `() => void persist()`, WarrantyTab
// passes its async handleSave.
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

import { fetchWithAuth } from '../../../stores/auth';
import { i18n } from '@/lib/i18n';
import { FeatureDirtyReporterContext } from './featureEditing';
import HardwareMonitoringTab from './HardwareMonitoringTab';
import WarrantyTab from './WarrantyTab';
import type { FeatureTabProps } from './types';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 400): Response =>
  ({ ok, status, statusText: 'x', json: vi.fn().mockResolvedValue(payload), headers: new Headers() }) as unknown as Response;

const props = (featureType: 'hardware_monitoring' | 'warranty'): FeatureTabProps => ({
  policyId: 'pol-1',
  existingLink: { id: `l-${featureType}`, featureType, featurePolicyId: null, inlineSettings: {} },
  linkedPolicyId: null,
  onLinkChanged: vi.fn(),
});

const saveButton = () => screen.getAllByRole('button').find((b) => /^save$/i.test(b.textContent?.trim() ?? ''))!;

describe('unsaved changes through real tabs (#12469)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('en');
  });

  it.each([
    ['HardwareMonitoringTab (void persist)', 'hardware_monitoring' as const, HardwareMonitoringTab],
    ['WarrantyTab (async handleSave)', 'warranty' as const, WarrantyTab],
  ])('%s: a good save clears the flag, a refused one keeps it', async (_name, featureType, Tab) => {
    const report = vi.fn();
    render(
      <FeatureDirtyReporterContext.Provider value={report}>
        <Tab {...props(featureType)} />
      </FeatureDirtyReporterContext.Provider>,
    );
    const field = screen.getAllByRole('spinbutton')[0];

    // Refused by the server: stays dirty.
    fetchMock.mockResolvedValueOnce(json({ error: 'Nope' }, false, 400));
    fireEvent.change(field, { target: { value: '15' } });
    expect(report).toHaveBeenLastCalledWith(true);
    report.mockClear();
    fireEvent.click(saveButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(saveButton()).not.toBeDisabled());
    await new Promise((r) => setTimeout(r, 10));
    expect(report).not.toHaveBeenCalledWith(false);

    // Accepted: clean.
    fetchMock.mockResolvedValueOnce(json({ data: { id: `l-${featureType}`, featureType, featurePolicyId: null, inlineSettings: {} } }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(report).toHaveBeenLastCalledWith(false));
  });
});
