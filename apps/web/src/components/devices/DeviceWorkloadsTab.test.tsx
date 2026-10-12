import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import DeviceWorkloadsTab from './DeviceWorkloadsTab';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const runtime = (over: Record<string, unknown>) => ({
  runtime: 'docker',
  detection: 'present',
  collection: 'ok',
  complete: true,
  runtimeVersion: '27.1.0',
  observedCount: 2,
  reportedCount: 2,
  lastError: null,
  collectedAt: '2026-10-12T10:00:00.000Z',
  lastAttemptAt: '2026-10-12T10:00:00.000Z',
  lastSuccessAt: '2026-10-12T10:00:00.000Z',
  ...over,
});

const workload = (over: Record<string, unknown>) => ({
  id: 'w1',
  runtime: 'docker',
  kind: 'container',
  workloadId: 'abc',
  name: 'web',
  state: 'running',
  rawState: 'running',
  imageRef: 'nginx:1.27',
  imageRepository: 'docker.io/library/nginx',
  imageTag: '1.27',
  imageDigest: null,
  imageId: null,
  guestOs: null,
  composeProject: 'shop',
  composeService: 'web',
  composeWorkingDir: null,
  restartPolicy: 'always',
  cpuCount: null,
  memoryMb: null,
  startedAt: '2026-10-12T09:00:00.000Z',
  runtimeCreatedAt: null,
  firstSeenAt: '2026-10-12T09:00:00.000Z',
  lastSeenAt: '2026-10-12T10:00:00.000Z',
  ...over,
});

beforeEach(() => {
  fetchWithAuthMock.mockReset();
});

describe('DeviceWorkloadsTab', () => {
  it('fetches the device workloads route and renders the runtime and its table', async () => {
    fetchWithAuthMock.mockResolvedValue(
      json({
        capability: 1,
        runtimes: [runtime({})],
        workloads: [workload({}), workload({ id: 'w2', workloadId: 'def', name: 'db', state: 'stopped', imageRef: 'postgres:16', composeProject: null, composeService: null })],
      }),
    );
    render(<DeviceWorkloadsTab deviceId="dev-1" />);
    const section = await screen.findByTestId('workloads-runtime-docker');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/dev-1/workloads');
    expect(within(section).getByText(/27\.1\.0/)).toBeTruthy();
    expect(within(section).getByText('web')).toBeTruthy();
    expect(within(section).getByText('nginx:1.27')).toBeTruthy();
    expect(within(section).getByText(/shop/)).toBeTruthy();
    expect(within(section).getByText('db')).toBeTruthy();
    expect(within(section).getByTestId('workloads-counts-docker').textContent).toMatch(/1 running/);
  });

  it('says the agent is too old when capability is 0', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ capability: 0, runtimes: [], workloads: [] }));
    render(<DeviceWorkloadsTab deviceId="dev-1" />);
    expect(await screen.findByText(/agent too old/i)).toBeTruthy();
  });

  it('explains that collection is off until a policy enables it', async () => {
    fetchWithAuthMock.mockResolvedValue(
      json({ capability: 1, runtimes: [runtime({ collection: 'disabled', observedCount: null, reportedCount: null })], workloads: [] }),
    );
    render(<DeviceWorkloadsTab deviceId="dev-1" />);
    expect(
      await screen.findByText('Collection is off — enable Workload inventory in a configuration policy'),
    ).toBeTruthy();
  });

  it('renders permission denied in plain language', async () => {
    fetchWithAuthMock.mockResolvedValue(
      json({ capability: 1, runtimes: [runtime({ collection: 'permission_denied', lastError: 'EACCES', lastSuccessAt: null })], workloads: [] }),
    );
    render(<DeviceWorkloadsTab deviceId="dev-1" />);
    expect(await screen.findByText('Permission denied')).toBeTruthy();
    // Never collected successfully: no "Last collected" claim.
    expect(screen.queryByText(/last collected/i)).toBeNull();
  });

  it('lists enumerated runtimes before detect-only containerd', async () => {
    fetchWithAuthMock.mockResolvedValue(
      json({
        capability: 1,
        runtimes: [runtime({ runtime: 'containerd', collection: 'unsupported' }), runtime({})],
        workloads: [],
      }),
    );
    render(<DeviceWorkloadsTab deviceId="dev-1" />);
    await screen.findByTestId('workloads-runtime-docker');
    const order = screen.getAllByTestId(/^workloads-runtime-/).map((el) => el.dataset.testid);
    expect(order).toEqual(['workloads-runtime-docker', 'workloads-runtime-containerd']);
  });

  it('shows a partial snapshot as a note, not an error', async () => {
    fetchWithAuthMock.mockResolvedValue(
      json({ capability: 1, runtimes: [runtime({ complete: false, observedCount: 5, reportedCount: 2 })], workloads: [workload({})] }),
    );
    render(<DeviceWorkloadsTab deviceId="dev-1" />);
    const note = await screen.findByTestId('workloads-partial-docker');
    expect(note.getAttribute('role')).not.toBe('alert');
    expect(screen.queryByTestId('workloads-error')).toBeNull();
  });

  it('never shows a count or table for detect-only containerd', async () => {
    fetchWithAuthMock.mockResolvedValue(
      json({
        capability: 1,
        runtimes: [runtime({ runtime: 'containerd', collection: 'unsupported', observedCount: 3, reportedCount: 0, runtimeVersion: '1.7.0' })],
        workloads: [],
      }),
    );
    render(<DeviceWorkloadsTab deviceId="dev-1" />);
    const section = await screen.findByTestId('workloads-runtime-containerd');
    expect(within(section).getByText(/detected only/i)).toBeTruthy();
    expect(within(section).queryByTestId('workloads-counts-containerd')).toBeNull();
    expect(within(section).queryByRole('table')).toBeNull();
  });

  it('shows the no-runtime state for a capable agent with nothing detected', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ capability: 1, runtimes: [], workloads: [] }));
    render(<DeviceWorkloadsTab deviceId="dev-1" />);
    expect(await screen.findByText(/no container or vm runtime/i)).toBeTruthy();
  });

  it('treats a 200 with an unexpected body as a failed load, not a render crash', async () => {
    fetchWithAuthMock.mockResolvedValue(json({}));
    render(<DeviceWorkloadsTab deviceId="dev-1" />);
    expect(await screen.findByTestId('workloads-error')).toBeTruthy();
  });

  it('ignores a late response for a previous device', async () => {
    let resolveOld: (r: Response) => void = () => {};
    fetchWithAuthMock.mockImplementation((url: string) =>
      url.includes('old-dev')
        ? new Promise<Response>((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(json({ capability: 1, runtimes: [runtime({})], workloads: [workload({ name: 'new-one' })] })),
    );
    const { rerender } = render(<DeviceWorkloadsTab deviceId="old-dev" />);
    rerender(<DeviceWorkloadsTab deviceId="new-dev" />);
    expect(await screen.findByText('new-one')).toBeTruthy();
    resolveOld(json({ capability: 1, runtimes: [runtime({})], workloads: [workload({ name: 'old-one' })] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('old-one')).toBeNull();
    expect(screen.getByText('new-one')).toBeTruthy();
  });

  it('surfaces a failed request', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ error: 'boom' }, false, 500));
    render(<DeviceWorkloadsTab deviceId="dev-1" />);
    expect(await screen.findByTestId('workloads-error')).toBeTruthy();
  });
});
