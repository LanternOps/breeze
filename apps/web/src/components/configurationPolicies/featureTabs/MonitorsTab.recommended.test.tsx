// MonitorsTab.recommended.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../../../lib/i18n';
import MonitorsTab from './MonitorsTab';
import type { FeatureLink, FeatureTabProps } from './types';

const { fetchMock, saveMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), saveMock: vi.fn() }));
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: fetchMock }));
vi.mock('./useFeatureLink', () => ({ useFeatureLink: () => ({
  save: saveMock, remove: vi.fn(), saving: false, error: undefined, clearError: vi.fn(),
}) }));
const POLICY = '10000000-0000-4000-8000-000000000009';
const CPU = '20000000-0000-4000-8000-000000000001';
const DISK = '20000000-0000-4000-8000-000000000002';
const CUSTOM = '20000000-0000-4000-8000-000000000003';
const catalog = [
  { id: CPU, name: 'High CPU usage', kind: 'cpu', builtinKey: 'cpu_high', condition: { value: 90 }, severity: 'high', enabled: true },
  { id: DISK, name: 'Disk almost full', kind: 'disk', builtinKey: 'disk_full', condition: { value: 90 }, severity: 'critical', enabled: true },
  { id: CUSTOM, name: 'Custom', kind: 'memory', builtinKey: null, condition: { value: 90 }, severity: 'high', enabled: true },
];
const link: FeatureLink = { id: 'l', featureType: 'monitors', featurePolicyId: null, inlineSettings: { items: [] } };
const base: FeatureTabProps = { policyId: POLICY, existingLink: link, linkedPolicyId: null,
  onLinkChanged: vi.fn(), allLinks: [link] };

function renderTab(existingLink = link) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: catalog }) });
  saveMock.mockResolvedValue(link);
  return render(<MonitorsTab {...base} existingLink={existingLink} />);
}

describe('MonitorsTab policy affordances', () => {
  it('links Create monitor with hash-based policy preselection', async () => {
    renderTab();
    expect(await screen.findByTestId('monitors-tab-create')).toHaveAttribute('href', `/alerts/monitors/new#policy=${POLICY}`);
  });
  it('uses the real mapper to find built-ins, attaches all locally, then saves', async () => {
    renderTab();
    expect(await screen.findByTestId('monitors-tab-recommended')).toHaveTextContent('Recommended monitors');
    fireEvent.click(screen.getByTestId('monitors-tab-recommended-attach'));
    expect(screen.queryByTestId('monitors-tab-recommended')).toBeNull();
    expect(screen.getByTestId(`monitors-tab-item-${CPU}`)).toHaveTextContent('High CPU usage');
    expect(screen.getByTestId(`monitors-tab-item-${DISK}`)).toHaveTextContent('Disk almost full');
    expect(screen.queryByTestId(`monitors-tab-item-${CUSTOM}`)).toBeNull();
    expect(saveMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith('l', expect.objectContaining({
      // W05c2 Task 4 added the inheritance switch, so the monitors link now
      // carries its mode; 'cumulative' is the default (add to inherited).
      featureType: 'monitors', inlineSettings: { inheritance: 'cumulative', checkIntervalSeconds: 60, items: [
        { monitorId: CPU, enabled: true, overrides: undefined, sortOrder: 0 },
        { monitorId: DISK, enabled: true, overrides: undefined, sortOrder: 1 },
      ] },
    })));
  });
  it('hides Recommended once any built-in is attached', async () => {
    renderTab({ ...link, inlineSettings: { items: [{ monitorId: CPU, enabled: true }] } });
    await screen.findByText('High CPU usage');
    expect(screen.queryByTestId('monitors-tab-recommended')).toBeNull();
  });
});
