// The Details tab is the one place a device's own record is edited (display
// name, role, tags, purchase date, custom fields). The old Device Settings
// modal duplicated half of it; these pin the half that moved here.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceInfoTab from './DeviceInfoTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./time/DeviceTimeSection', () => ({ default: () => null }));

const fetchMock = vi.mocked(fetchWithAuth);
const deviceId = '11111111-1111-1111-1111-111111111111';

function json(payload: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) } as unknown as Response;
}

function load(device: Record<string, unknown>) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === `/devices/${deviceId}` && method === 'GET') {
      return json({ hostname: 'TST-01', displayName: null, osType: 'windows', status: 'online', tags: [], ...device });
    }
    if (url === `/devices/${deviceId}` && method === 'PATCH') return json({ success: true });
    if (url === '/custom-fields') return json({ data: [] });
    return json({}, false);
  });
}

function patchBodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String(init?.body)));
}

describe('DeviceInfoTab — tags', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the Tags card even with no tags, so a first tag can be added', async () => {
    load({ tags: [] });
    render(<DeviceInfoTab deviceId={deviceId} />);
    const card = await screen.findByTestId('device-tags');
    expect(within(card).getByText('No tags')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Edit tags' })).toBeInTheDocument();
  });

  it('adds tags trimmed, lowercased and de-duplicated, removes one, and saves the list', async () => {
    load({ tags: ['lab'] });
    const onSaved = vi.fn();
    render(<DeviceInfoTab deviceId={deviceId} onSaved={onSaved} />);
    const card = await screen.findByTestId('device-tags');
    fireEvent.click(within(card).getByRole('button', { name: 'Edit tags' }));

    const input = within(card).getByRole('textbox', { name: 'Add a tag' });
    fireEvent.change(input, { target: { value: '  Kiosk ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'kiosk' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'front-desk' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Add' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Remove tag lab' }));

    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchBodies()).toEqual([{ tags: ['kiosk', 'front-desk'] }]));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(within(card).getByText('kiosk')).toBeInTheDocument();
    expect(within(card).queryByText('lab')).toBeNull();
  });

  it('Cancel drops the draft without saving', async () => {
    load({ tags: ['lab'] });
    render(<DeviceInfoTab deviceId={deviceId} />);
    const card = await screen.findByTestId('device-tags');
    fireEvent.click(within(card).getByRole('button', { name: 'Edit tags' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Remove tag lab' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(within(card).getByText('lab')).toBeInTheDocument();
    expect(patchBodies()).toEqual([]);
  });
});

describe('DeviceInfoTab — purchase date', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets a purchase date', async () => {
    load({ purchaseDate: null, purchaseDateSource: null });
    const onSaved = vi.fn();
    render(<DeviceInfoTab deviceId={deviceId} onSaved={onSaved} />);
    const row = await screen.findByTestId('device-purchase-date');
    expect(within(row).getByText('Not set')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Edit purchase date' }));
    fireEvent.change(within(row).getByLabelText('Purchase date'), { target: { value: '2024-01-05' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchBodies()).toEqual([{ purchaseDate: '2024-01-05' }]));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('clearing the date sends null', async () => {
    load({ purchaseDate: '2023-03-01', purchaseDateSource: 'manual' });
    render(<DeviceInfoTab deviceId={deviceId} />);
    const row = await screen.findByTestId('device-purchase-date');
    fireEvent.click(within(row).getByRole('button', { name: 'Edit purchase date' }));
    fireEvent.change(within(row).getByLabelText('Purchase date'), { target: { value: '' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchBodies()).toEqual([{ purchaseDate: null }]));
  });

  it('sits in the Warranty & purchase section, not in System', async () => {
    load({ purchaseDate: '2023-03-01', purchaseDateSource: 'manual' });
    render(<DeviceInfoTab deviceId={deviceId} />);
    const row = await screen.findByTestId('device-purchase-date');
    expect(row.closest('[data-testid="device-warranty"]')).not.toBeNull();
  });

  it('says when the date came from the manufacturer', async () => {
    load({ purchaseDate: '2023-03-01', purchaseDateSource: 'vendor' });
    render(<DeviceInfoTab deviceId={deviceId} />);
    const row = await screen.findByTestId('device-purchase-date');
    expect(within(row).getByText('From manufacturer')).toBeInTheDocument();
  });
});

describe('DeviceInfoTab — saves refresh the page', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a display-name save tells the page, so the header name updates', async () => {
    load({ displayName: null });
    const onSaved = vi.fn();
    render(<DeviceInfoTab deviceId={deviceId} onSaved={onSaved} />);
    fireEvent.click(await screen.findByTitle('Edit display name'));
    fireEvent.change(screen.getByPlaceholderText(/blank to clear/i), { target: { value: 'Front Desk' } });
    fireEvent.click(screen.getByTitle('Save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });
});
