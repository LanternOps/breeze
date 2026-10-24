/**
 * Wave F (#9791) — the transport half of the reliability → event-log link:
 * the linked filter props become the exact source / startDate / endDate sent
 * on /devices/:id/eventlogs. (The plan calls this DeviceEventLog.hash.test;
 * the `#eventlog` tab's component is DeviceLogsTab.)
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceLogsTab from './DeviceLogsTab';
import { fetchWithAuth } from '../../stores/auth';
import { deviceEventLogHash } from '@/lib/deviceEventLogLink';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

const from = '2026-09-24T00:00:00.000Z';
const to = '2026-10-24T12:30:00.000Z';

const empty = () =>
  ({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({ data: [], pagination: { total: 0 } }),
  }) as unknown as Response;

function lastParams() {
  const url = String(fetchMock.mock.calls.at(-1)![0]);
  return new URL(url, 'http://x').searchParams;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => empty());
  window.location.hash = '';
});

describe('DeviceLogsTab linked filter (#9791 F1)', () => {
  it('sends the linked source and ISO window verbatim on the first fetch', async () => {
    render(
      <DeviceLogsTab
        deviceId="d1"
        osType="windows"
        linkedFilter={{ source: 'Service Control Manager', from, to }}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const p = new URL(String(fetchMock.mock.calls[0]![0]), 'http://x').searchParams;
    expect(p.get('source')).toBe('Service Control Manager');
    expect(p.get('startDate')).toBe(from);
    expect(p.get('endDate')).toBe(to);
    expect(p.get('page')).toBe('1');
  });

  it('shows the banner and populated inputs', async () => {
    render(<DeviceLogsTab deviceId="d1" linkedFilter={{ source: 'disk', from, to }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByTestId('device-logs-linked-filter')).toHaveTextContent('disk');
    expect(screen.getByTestId('device-logs-source-input')).toHaveValue('disk');
    expect((screen.getByTestId('device-logs-start-date') as HTMLInputElement).value).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    );
    expect((screen.getByTestId('device-logs-end-date') as HTMLInputElement).value).not.toBe('');
  });

  it('sends no source param for a window-only link', async () => {
    render(<DeviceLogsTab deviceId="d1" linkedFilter={{ from, to }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const p = lastParams();
    expect(p.has('source')).toBe(false);
    expect(p.get('startDate')).toBe(from);
    expect(screen.getByTestId('device-logs-linked-filter')).toBeInTheDocument();
  });

  it('clearing resets to the bare #eventlog hash and drops the filter params', async () => {
    const user = userEvent.setup();
    window.location.hash = `#${deviceEventLogHash({ source: 'disk', from, to })}`;
    render(<DeviceLogsTab deviceId="d1" linkedFilter={{ source: 'disk', from, to }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await user.click(screen.getByTestId('device-logs-linked-filter-clear'));
    expect(window.location.hash).toBe('#eventlog');
    await waitFor(() => {
      const p = lastParams();
      expect(p.has('source')).toBe(false);
      expect(p.has('startDate')).toBe(false);
      expect(p.has('endDate')).toBe(false);
    });
    expect(screen.queryByTestId('device-logs-linked-filter')).not.toBeInTheDocument();
  });

  it('a manual edit drops the linked state and the hash params', async () => {
    const user = userEvent.setup();
    window.location.hash = `#${deviceEventLogHash({ source: 'disk', from, to })}`;
    render(<DeviceLogsTab deviceId="d1" linkedFilter={{ source: 'disk', from, to }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await user.selectOptions(screen.getByTestId('device-logs-level-select'), 'error');
    expect(window.location.hash).toBe('#eventlog');
    expect(screen.queryByTestId('device-logs-linked-filter')).not.toBeInTheDocument();
  });

  it('re-seeds when the linked filter changes while mounted', async () => {
    const { rerender } = render(
      <DeviceLogsTab deviceId="d1" linkedFilter={{ source: 'disk', from, to }} />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {
      rerender(<DeviceLogsTab deviceId="d1" linkedFilter={{ source: 'Ntfs', from, to }} />);
    });
    await waitFor(() => expect(lastParams().get('source')).toBe('Ntfs'));
  });

  it('without a linked filter nothing is seeded', async () => {
    render(<DeviceLogsTab deviceId="d1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const p = lastParams();
    expect(p.has('source')).toBe(false);
    expect(p.has('startDate')).toBe(false);
    expect(screen.queryByTestId('device-logs-linked-filter')).not.toBeInTheDocument();
  });
});
