import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import {
  WORKLOAD_INVENTORY_MAX_INTERVAL_MINUTES,
  WORKLOAD_INVENTORY_MIN_INTERVAL_MINUTES,
} from '@breeze/shared';
const m = vi.hoisted(() => ({
  save: vi.fn(),
  remove: vi.fn(),
  changed: vi.fn(),
}));
vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: m.save,
    remove: m.remove,
    saving: false,
    error: undefined,
    clearError: vi.fn(),
  }),
}));
import WorkloadInventoryTab from './WorkloadInventoryTab';
const props = {
  policyId: 'policy',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: m.changed,
};
const saveButton = () =>
  screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement;
const checked = (testId: string) =>
  (screen.getByTestId(testId) as HTMLInputElement).checked;
beforeEach(() => {
  vi.clearAllMocks();
  m.save.mockResolvedValue({
    id: 'link',
    featureType: 'workload_inventory',
    featurePolicyId: null,
    inlineSettings: {},
  });
});
it('starts from the shared defaults: listing off, every runtime toggle on, 60 minutes', () => {
  render(<WorkloadInventoryTab {...props} />);
  expect(checked('workload-inventory-enabled')).toBe(false);
  for (const runtime of ['docker', 'podman', 'hyperv', 'proxmox']) {
    expect(checked(`workload-inventory-${runtime}`)).toBe(true);
  }
  expect(
    (screen.getByTestId('workload-inventory-interval') as HTMLInputElement).value,
  ).toBe('60');
  expect(screen.getByText(/off until a policy enables it/i)).toBeTruthy();
});
it('uses the shared interval bounds on the input', () => {
  render(<WorkloadInventoryTab {...props} />);
  const input = screen.getByTestId('workload-inventory-interval') as HTMLInputElement;
  expect(input.min).toBe(String(WORKLOAD_INVENTORY_MIN_INTERVAL_MINUTES));
  expect(input.max).toBe(String(WORKLOAD_INVENTORY_MAX_INTERVAL_MINUTES));
});
it('saves camelCase inline settings through the feature link', async () => {
  render(<WorkloadInventoryTab {...props} />);
  fireEvent.click(screen.getByTestId('workload-inventory-enabled'));
  fireEvent.click(screen.getByTestId('workload-inventory-podman'));
  fireEvent.change(screen.getByTestId('workload-inventory-interval'), {
    target: { value: '30' },
  });
  fireEvent.click(saveButton());
  await waitFor(() =>
    expect(m.save).toHaveBeenCalledWith(null, {
      featureType: 'workload_inventory',
      featurePolicyId: null,
      inlineSettings: {
        enabled: true,
        dockerEnabled: true,
        podmanEnabled: false,
        hypervEnabled: true,
        proxmoxEnabled: true,
        intervalMinutes: 30,
      },
    }),
  );
  await waitFor(() =>
    expect(m.changed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'link' }),
      'workload_inventory',
    ),
  );
});
it.each(['', '5', '1441', '20.5'])('disables save for interval %s', (value) => {
  render(<WorkloadInventoryTab {...props} />);
  fireEvent.change(screen.getByTestId('workload-inventory-interval'), {
    target: { value },
  });
  expect(saveButton().disabled).toBe(true);
  expect(screen.getByRole('alert')).toBeTruthy();
});
it('loads the existing link and updates it in place', async () => {
  render(
    <WorkloadInventoryTab
      {...props}
      existingLink={{
        id: 'existing',
        featureType: 'workload_inventory',
        featurePolicyId: null,
        inlineSettings: {
          enabled: true,
          dockerEnabled: false,
          podmanEnabled: true,
          hypervEnabled: true,
          proxmoxEnabled: true,
          intervalMinutes: 120,
        },
      }}
    />,
  );
  expect(checked('workload-inventory-enabled')).toBe(true);
  expect(checked('workload-inventory-docker')).toBe(false);
  fireEvent.click(saveButton());
  await waitFor(() =>
    expect(m.save).toHaveBeenCalledWith(
      'existing',
      expect.objectContaining({
        inlineSettings: expect.objectContaining({ dockerEnabled: false, intervalMinutes: 120 }),
      }),
    ),
  );
});
it('shows an inherited parent setting read-only until overridden', () => {
  render(
    <WorkloadInventoryTab
      {...props}
      parentLink={{
        id: 'parent',
        featureType: 'workload_inventory',
        featurePolicyId: null,
        inlineSettings: { enabled: true },
      }}
    />,
  );
  expect(checked('workload-inventory-enabled')).toBe(true);
  expect(screen.getByTestId('workload-inventory-enabled')).toBeDisabled();
});
it('does not claim Hyper-V/Proxmox listing is a later release (#8519)', () => {
  render(<WorkloadInventoryTab {...props} />);
  expect(screen.queryByText(/later agent release/i)).toBeNull();
  expect(
    screen.getByText(
      'Hyper-V and Proxmox VE toggles only take effect on agents that include these drivers; older agents ignore them.',
    ),
  ).toBeTruthy();
});
