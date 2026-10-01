import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../../stores/auth';
import DeviceTimeSection from './DeviceTimeSection';
import { view } from './fixtures';
import { findingCopy } from './timeSyncCopy';
import en from '../../../locales/en/devices.json';
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
beforeEach(() => vi.mocked(fetchWithAuth).mockReset());
it.each([
  [
    'not_reported',
    'No time data yet — this needs an agent update that includes time sync',
  ],
  ['unsupported_os', 'Not supported on this OS yet'],
] as const)('renders %s as an ordinary empty state', async (state, message) => {
  vi.mocked(fetchWithAuth).mockResolvedValue(
    response(
      view({ state, config: null, status: null, domain: null, timezone: null }),
    ),
  );
  render(<DeviceTimeSection deviceId="one" />);
  expect(await screen.findByTestId('time-empty')).toHaveTextContent(message);
  expect(screen.queryByTestId('time-health')).not.toBeInTheDocument();
});
it('renders reported details, UTC default, stale evidence and escaped event messages', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(
    response(view({ stale: true, health: 'warning' })),
  );
  const { container } = render(<DeviceTimeSection deviceId="one" />);
  expect(await screen.findByTestId('time-stale')).toHaveTextContent('Stale');
  expect(screen.getByTestId('time-health')).toHaveTextContent('Warning');
  expect(screen.getByTestId('time-expected')).toHaveTextContent(
    'No expected timezone (site uses the UTC default)',
  );
  expect(screen.getByTestId('time-facts')).toHaveTextContent('pool.ntp.org');
  fireEvent.click(screen.getByTestId('time-events-toggle'));
  expect(screen.getByTestId('time-event-9')).toHaveTextContent(
    '<script>untrusted display text</script>',
  );
  expect(container.querySelector('script')).toBeNull();
});
it.each(['no_site', 'unmapped'] as const)(
  'explains expected timezone %s',
  async (reason) => {
    const v = view();
    v.timezone!.expectedUnsetReason = reason;
    vi.mocked(fetchWithAuth).mockResolvedValue(response(v));
    render(<DeviceTimeSection deviceId="one" />);
    expect(await screen.findByTestId('time-expected')).toHaveTextContent(
      en.timeSync.unset[reason],
    );
  },
);
it('uses parent expected provenance when finding detail lacks it and resolves device placeholders', async () => {
  const v = view();
  v.timezone!.expected = {
    iana: 'America/Detroit',
    windowsId: 'Eastern Standard Time',
    source: 'site',
    sourceId: 'site',
    sourceName: 'Main',
  };
  v.timezone!.expectedUnsetReason = null;
  v.findings = [
    {
      code: 'timezone_mismatch',
      severity: 'info',
      detail: {
        actual: 'Pacific Standard Time',
        expected: 'Eastern Standard Time',
      },
    },
  ];
  vi.mocked(fetchWithAuth).mockResolvedValue(response(v));
  render(<DeviceTimeSection deviceId="one" deviceName="Device A" />);
  expect(await screen.findByTestId('time-expected')).toHaveTextContent('Main');
  expect(
    screen.getByTestId('time-finding-timezone_mismatch'),
  ).toHaveTextContent(
    'Timezone is Pacific Standard Time, expected Eastern Standard Time (from Main).',
  );
  const t = (key: string) =>
    key === 'devices:timeSync.unknown'
      ? 'Unknown'
      : key.endsWith('.hint')
        ? en.timeSync.findings.pdc_no_external_source.hint
        : en.timeSync.findings.pdc_no_external_source.label;
  expect(
    findingCopy(
      t,
      {
        code: 'pdc_no_external_source',
        severity: 'critical',
        detail: { domainDns: null },
      },
      'Device A',
      null,
    ).hint,
  ).toContain('Set NTP servers on Device A');
});
it.each(['site', 'policy'] as const)(
  'uses the translated %s source when the parent name is absent',
  async (source) => {
    const v = view();
    v.timezone!.expected = {
      iana: 'America/Detroit',
      windowsId: 'Eastern Standard Time',
      source,
      sourceId: 'source-id',
      sourceName: null,
    };
    v.findings = [
      {
        code: 'timezone_mismatch',
        severity: 'info',
        detail: {
          actual: 'Pacific Standard Time',
          expected: 'Eastern Standard Time',
          expectedSource: 'site',
          expectedSourceName: 'Old name',
        },
      },
    ];
    vi.mocked(fetchWithAuth).mockResolvedValue(response(v));
    render(<DeviceTimeSection deviceId="one" />);
    expect(
      await screen.findByTestId('time-finding-timezone_mismatch'),
    ).toHaveTextContent(`(from ${en.timeSync[source]}).`);
    expect(
      screen.getByTestId('time-finding-timezone_mismatch'),
    ).not.toHaveTextContent('Old name');
  },
);
it('shows Group Policy management and pinned-policy provenance without implying writes', async () => {
  const v = view();
  v.config!.policyManaged = true;
  v.timezone!.expected = {
    iana: 'UTC',
    windowsId: 'UTC',
    source: 'policy',
    sourceId: 'policy',
    sourceName: 'Servers',
  };
  v.status!.source = null;
  vi.mocked(fetchWithAuth).mockResolvedValue(response(v));
  render(<DeviceTimeSection deviceId="one" />);
  expect(await screen.findByTestId('time-gpo')).toHaveTextContent(
    'Managed by Group Policy',
  );
  expect(screen.getByTestId('time-expected')).toHaveTextContent(
    'overrides the site timezone',
  );
  expect(screen.getByTestId('time-facts')).toHaveTextContent('Unknown');
});
it('shows loading, surfaces failure and retries', async () => {
  vi.mocked(fetchWithAuth)
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce(response(view()));
  render(<DeviceTimeSection deviceId="one" />);
  expect(screen.getByTestId('time-loading')).toBeInTheDocument();
  fireEvent.click(await screen.findByTestId('time-retry'));
  expect(await screen.findByTestId('time-health')).toHaveTextContent('Healthy');
});
it('ignores a late old-device response and aborts on unmount', async () => {
  let resolveOld!: (response: Response) => void;
  vi.mocked(fetchWithAuth)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce(response(view({ health: 'critical' })));
  const rendered = render(<DeviceTimeSection deviceId="old" />);
  rendered.rerender(<DeviceTimeSection deviceId="new" />);
  await waitFor(() =>
    expect(screen.getByTestId('time-health')).toHaveTextContent('Critical'),
  );
  await act(async () => {
    resolveOld(response(view()));
  });
  expect(screen.getByTestId('time-health')).toHaveTextContent('Critical');
  rendered.unmount();
  const signal = vi.mocked(fetchWithAuth).mock.calls[1]![1]!
    .signal as AbortSignal;
  expect(signal.aborted).toBe(true);
});
