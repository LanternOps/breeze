import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyLocale, i18n } from '../../lib/i18n';

import ProcessDrilldownPanel from './ProcessDrilldownPanel';
import { fetchWithAuth } from '../../stores/auth';

// #3632: with `t` in the load effect's deps, a `languageChanged` (fired after
// hydration for every saved non-English locale) re-ran the fetch. In Live mode
// that is an on-demand process listing executed on the device itself.
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

const liveCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('/system-tools/devices/')).length;

describe('ProcessDrilldownPanel: a locale change must not re-query the device', () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url) =>
      String(url).includes('/system-tools/')
        ? jsonRes({ data: [{ name: 'live-proc', pid: 9, cpuPercent: 3, memoryMb: 7 }] })
        : jsonRes({ sample: { timestamp: '2026-06-13T12:31:40.000Z', topProcesses: [] } }),
    );
    await act(() => i18n.changeLanguage('en'));
  });

  afterEach(async () => {
    await act(() => i18n.changeLanguage('en'));
  });

  it('does not issue a second live process listing when the language changes', async () => {
    render(<ProcessDrilldownPanel deviceId="dev-1" at="2026-06-13T12:32:00.000Z" onClose={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('process-drilldown-live-toggle'));
    await waitFor(() => expect(liveCalls()).toBe(1));
    await screen.findByText('live-proc');
    const totalBefore = fetchMock.mock.calls.length;

    await act(async () => {
      await applyLocale('fr-FR');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(liveCalls()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(totalBefore);
  });

  it('still refetches when the device actually changes', async () => {
    const { rerender } = render(
      <ProcessDrilldownPanel deviceId="dev-1" at="2026-06-13T12:32:00.000Z" onClose={() => {}} />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(<ProcessDrilldownPanel deviceId="dev-2" at="2026-06-13T12:32:00.000Z" onClose={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('/devices/dev-2/process-samples'));
  });
});
