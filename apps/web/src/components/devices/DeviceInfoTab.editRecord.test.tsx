// The Details tab is the one place a device's own record is edited (display
// name, role, tags, purchase date, custom fields). These cover tags, purchase
// date, and the page refresh after a save.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceInfoTab from './DeviceInfoTab';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./time/DeviceTimeSection', () => ({ default: () => null }));

const fetchMock = vi.mocked(fetchWithAuth);
const deviceId = '11111111-1111-1111-1111-111111111111';

function json(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) } as unknown as Response;
}

/** `patch` answers the save; by default it succeeds. */
function load(device: Record<string, unknown>, patch: () => Response = () => json({ success: true })) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === `/devices/${deviceId}` && method === 'GET') {
      return json({ hostname: 'TST-01', displayName: null, osType: 'windows', status: 'online', tags: [], ...device });
    }
    if (url === `/devices/${deviceId}` && method === 'PATCH') return patch();
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
    // Back to the read view (no editor), showing the saved list.
    await waitFor(() => expect(within(card).queryByRole('textbox')).toBeNull());
    expect(within(card).getByText('kiosk')).toBeInTheDocument();
    expect(within(card).queryByText('lab')).toBeNull();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('saves a tag that was typed but not added, and sends nothing when nothing changed', async () => {
    load({ tags: ['lab'] });
    render(<DeviceInfoTab deviceId={deviceId} />);
    const card = await screen.findByTestId('device-tags');

    fireEvent.click(within(card).getByRole('button', { name: 'Edit tags' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(card).queryByRole('textbox')).toBeNull());
    expect(patchBodies()).toEqual([]);

    fireEvent.click(within(card).getByRole('button', { name: 'Edit tags' }));
    fireEvent.change(within(card).getByRole('textbox', { name: 'Add a tag' }), { target: { value: 'kiosk' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchBodies()).toEqual([{ tags: ['lab', 'kiosk'] }]));
  });

  it('a failed save says why, keeps the editor open, and Cancel returns to the saved tags', async () => {
    load({ tags: ['lab'] }, () => json({ error: 'Tag limit exceeded' }, false, 400));
    const onSaved = vi.fn();
    render(<DeviceInfoTab deviceId={deviceId} onSaved={onSaved} />);
    const card = await screen.findByTestId('device-tags');
    fireEvent.click(within(card).getByRole('button', { name: 'Edit tags' }));
    fireEvent.change(within(card).getByRole('textbox', { name: 'Add a tag' }), { target: { value: 'kiosk' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));

    expect(await within(card).findByRole('alert')).toHaveTextContent('Tag limit exceeded');
    expect(within(card).getByRole('textbox', { name: 'Add a tag' })).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();

    fireEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(within(card).queryByRole('alert')).toBeNull();
    expect(within(card).getByText('lab')).toBeInTheDocument();
    expect(within(card).queryByText('kiosk')).toBeNull();
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

  it('a failed save says why and keeps the editor open; Cancel clears the error and keeps the saved date', async () => {
    load({ purchaseDate: '2023-03-01', purchaseDateSource: 'manual' }, () => json({ error: 'Purchase date is in the future' }, false, 400));
    const onSaved = vi.fn();
    render(<DeviceInfoTab deviceId={deviceId} onSaved={onSaved} />);
    const row = await screen.findByTestId('device-purchase-date');
    fireEvent.click(within(row).getByRole('button', { name: 'Edit purchase date' }));
    fireEvent.change(within(row).getByLabelText('Purchase date'), { target: { value: '2031-01-05' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));

    expect(await within(row).findByRole('alert')).toHaveTextContent('Purchase date is in the future');
    expect(within(row).getByLabelText('Purchase date')).toHaveValue('2031-01-05');
    expect(onSaved).not.toHaveBeenCalled();

    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }));
    expect(within(row).queryByRole('alert')).toBeNull();
    expect(within(row).getByText('Mar 1, 2023')).toBeInTheDocument();
  });

  it('Escape clears a save error too', async () => {
    load({ purchaseDate: null, purchaseDateSource: null }, () => json({ error: 'Nope' }, false, 400));
    render(<DeviceInfoTab deviceId={deviceId} />);
    const row = await screen.findByTestId('device-purchase-date');
    fireEvent.click(within(row).getByRole('button', { name: 'Edit purchase date' }));
    const input = within(row).getByLabelText('Purchase date');
    fireEvent.change(input, { target: { value: '2024-01-05' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await within(row).findByRole('alert');
    fireEvent.keyDown(within(row).getByLabelText('Purchase date'), { key: 'Escape' });
    expect(within(row).queryByRole('alert')).toBeNull();
  });

  it('pressing Enter twice saves once', async () => {
    let finish!: (response: Response) => void;
    const slow = new Promise<Response>((resolve) => { finish = resolve; });
    load({ purchaseDate: null, purchaseDateSource: null });
    const answer = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => (init?.method === 'PATCH' ? slow : answer(input, init)));
    const onSaved = vi.fn();
    render(<DeviceInfoTab deviceId={deviceId} onSaved={onSaved} />);
    const row = await screen.findByTestId('device-purchase-date');
    fireEvent.click(within(row).getByRole('button', { name: 'Edit purchase date' }));
    const input = within(row).getByLabelText('Purchase date');
    fireEvent.change(input, { target: { value: '2024-01-05' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    finish(json({ success: true }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(patchBodies()).toEqual([{ purchaseDate: '2024-01-05' }]);
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
