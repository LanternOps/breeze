import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import DeviceList, { type Device } from './DeviceList';
import { DEFAULT_VISIBLE_COLUMNS, writeColumnVisibility } from './columnVisibility';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
  hasPermission: () => true,
}));

// #9863 — fleet-wide warranty view: an opt-in "Warranty Ends" column on the
// device list, fed by the list row's warrantyEndDate / warrantyStatus.
const device = (id: string, hostname: string, extra: Partial<Device> = {}): Device => ({
  id, deviceClass: 'agent', hostname,
  os: 'windows', osVersion: '11', status: 'online', cpuPercent: 0, ramPercent: 0,
  lastSeen: '2026-09-23T12:00:00Z', orgId: '33333333-3333-4333-8333-333333333333', orgName: 'Acme',
  siteId: '44444444-4444-4444-8444-444444444444', siteName: 'HQ', agentVersion: '0.117.0', tags: [],
  ...extra,
});
const showColumn = () => writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'warranty']);
afterEach(() => window.localStorage.clear());

it('keeps the column hidden by default', () => {
  const d = device('11111111-1111-4111-8111-111111111111', 'laptop', { warrantyEndDate: '2026-12-31', warrantyStatus: 'expiring' });
  render(<DeviceList devices={[d]} />);
  expect(screen.queryByTestId(`device-${d.id}-warranty`)).toBeNull();
});

it('shows the end date as a calendar date with the stored status', () => {
  showColumn();
  const d = device('11111111-1111-4111-8111-111111111111', 'laptop', { warrantyEndDate: '2026-12-31', warrantyStatus: 'expiring' });
  render(<DeviceList devices={[d]} />);
  const cell = screen.getByTestId(`device-${d.id}-warranty`);
  // A bare YYYY-MM-DD must render as that local day, not UTC midnight
  // shifted to the previous day west of UTC.
  expect(cell).toHaveTextContent(new Date(2026, 11, 31).toLocaleDateString());
  expect(screen.getByTestId(`device-${d.id}-warranty-status`)).toHaveTextContent('Expiring');
});

it('renders a dash when the device has no warranty record', () => {
  showColumn();
  const d = device('11111111-1111-4111-8111-111111111111', 'laptop', { warrantyEndDate: null, warrantyStatus: null });
  render(<DeviceList devices={[d]} />);
  expect(screen.getByTestId(`device-${d.id}-warranty`)).toHaveTextContent('—');
  expect(screen.queryByTestId(`device-${d.id}-warranty-status`)).toBeNull();
});

it('sorts by end date, keeping devices without one last in both directions', () => {
  showColumn();
  const soon = device('11111111-1111-4111-8111-111111111111', 'soon', { warrantyEndDate: '2026-11-15', warrantyStatus: 'expiring' });
  const later = device('22222222-2222-4222-8222-222222222222', 'later', { warrantyEndDate: '2028-03-01', warrantyStatus: 'active' });
  const none = device('33333333-3333-4333-8333-333333333333', 'none', { warrantyEndDate: null, warrantyStatus: null });
  render(<DeviceList devices={[later, none, soon]} pageSize={50} />);
  const header = screen.getByTitle('Sort by warranty end date');
  const order = () => screen.getAllByTestId(/-warranty$/).map((cell) => cell.getAttribute('data-testid'));

  fireEvent.click(header);
  expect(order()).toEqual([`device-${soon.id}-warranty`, `device-${later.id}-warranty`, `device-${none.id}-warranty`]);
  fireEvent.click(header);
  expect(order()).toEqual([`device-${later.id}-warranty`, `device-${soon.id}-warranty`, `device-${none.id}-warranty`]);
});

it('notifies the data owner when warranty visibility changes', () => {
  const onWarrantyRequiredChange = vi.fn();
  render(<DeviceList devices={[device('11111111-1111-4111-8111-111111111111', 'laptop')]} onWarrantyRequiredChange={onWarrantyRequiredChange} />);
  expect(onWarrantyRequiredChange).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByTestId('column-chooser-trigger'));
  fireEvent.click(within(screen.getByTestId('column-chooser-option-warranty')).getByRole('checkbox'));
  expect(onWarrantyRequiredChange).toHaveBeenLastCalledWith(true);
});
