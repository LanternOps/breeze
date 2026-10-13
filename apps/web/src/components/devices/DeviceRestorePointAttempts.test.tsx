import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import DeviceRestorePointAttempts from './DeviceRestorePointAttempts';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

function attempt(over: Record<string, unknown> = {}) {
  return {
    requestId: '11111111-1111-4111-8111-111111111111',
    trigger: 'script',
    status: 'requested',
    policyRevision: null,
    requestedAt: '2026-09-02T14:00:00.000Z',
    attemptedAt: null,
    receivedAt: null,
    sequenceNumber: null,
    description: null,
    message: null,
    acceptedExistingPoint: false,
    existingPointAgeMinutes: null,
    frequencyMinutes: null,
    durationMs: null,
    scriptExecutionId: null,
    softwareDeploymentId: null,
    patchJobId: null,
    ...over,
  };
}

function respond(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('DeviceRestorePointAttempts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists attempts newest first with their trigger and badge', async () => {
    fetchMock.mockResolvedValue(
      respond({
        attempts: [
          attempt({
            requestId: '22222222-2222-4222-8222-222222222222',
            trigger: 'patch',
            status: 'created',
            requestedAt: '2026-09-02T14:00:00.000Z',
            attemptedAt: '2026-09-02T14:00:05.000Z',
          }),
          attempt({
            requestId: '11111111-1111-4111-8111-111111111111',
            trigger: 'script',
            status: 'busy',
            requestedAt: '2026-09-01T09:00:00.000Z',
          }),
        ],
      }),
    );
    render(<DeviceRestorePointAttempts deviceId="dev-1" />);

    const rows = await screen.findAllByTestId(/^restore-point-attempt-row-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'restore-point-attempt-row-22222222-2222-4222-8222-222222222222',
      'restore-point-attempt-row-11111111-1111-4111-8111-111111111111',
    ]);
    expect(within(rows[0]!).getByText('Patch install')).toBeTruthy();
    expect(within(rows[0]!).getByTestId('restore-point-badge').textContent).toMatch(/confirmed/i);
    expect(within(rows[1]!).getByText('Script run')).toBeTruthy();
    expect(within(rows[1]!).getByTestId('restore-point-badge').textContent).toMatch(/volume snapshot service/i);
    expect(fetchMock).toHaveBeenCalledWith('/devices/dev-1/restore-point-attempts?limit=50');
  });

  it('renders an explicit empty state rather than an empty table', async () => {
    fetchMock.mockResolvedValue(respond({ attempts: [] }));
    render(<DeviceRestorePointAttempts deviceId="dev-1" />);
    expect(await screen.findByTestId('restore-point-attempts-empty')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says plainly that System Restore is not a backup, in every state', async () => {
    fetchMock.mockResolvedValue(respond({ attempts: [attempt()] }));
    const { unmount } = render(<DeviceRestorePointAttempts deviceId="dev-1" />);
    expect(
      (await screen.findByTestId('restore-point-attempts-disclaimer')).textContent?.toLowerCase(),
    ).toContain('not a backup');
    unmount();

    fetchMock.mockResolvedValue(respond({ attempts: [] }));
    const empty = render(<DeviceRestorePointAttempts deviceId="dev-1" />);
    await screen.findByTestId('restore-point-attempts-empty');
    expect(screen.getByTestId('restore-point-attempts-disclaimer').textContent?.toLowerCase()).toContain('not a backup');
    empty.unmount();

    fetchMock.mockResolvedValue(respond({}, false, 500));
    render(<DeviceRestorePointAttempts deviceId="dev-1" />);
    await screen.findByTestId('restore-point-attempts-error');
    expect(screen.getByTestId('restore-point-attempts-disclaimer').textContent?.toLowerCase()).toContain('not a backup');
  });

  it('shows a stuck requested row as pending, not as success', async () => {
    fetchMock.mockResolvedValue(
      respond({ attempts: [attempt({ status: 'requested', requestedAt: '2026-09-01T00:00:00Z', trigger: 'script' })] }),
    );
    render(<DeviceRestorePointAttempts deviceId="dev-1" />);
    const badge = await screen.findByTestId('restore-point-badge');
    expect(badge.textContent).toMatch(/awaiting the device/i);
    expect(badge.textContent).not.toMatch(/confirmed/i);
  });

  it('never renders a recoverability promise anywhere on the list', async () => {
    const statuses = [
      'requested', 'created', 'existing_accepted', 'skipped_disabled', 'skipped_definition_only',
      'unsupported', 'busy', 'insufficient_privileges', 'verification_failed', 'failed',
    ];
    fetchMock.mockResolvedValue(
      respond({
        attempts: statuses.map((status, i) =>
          attempt({
            requestId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
            status,
            message: 'boom',
            existingPointAgeMinutes: 240,
            frequencyMinutes: 1440,
          }),
        ),
      }),
    );
    const { container } = render(<DeviceRestorePointAttempts deviceId="dev-1" />);
    await screen.findAllByTestId('restore-point-badge');
    const text = (container.textContent ?? '').toLowerCase();
    expect(text).not.toContain('rollback available');
    expect(text).not.toContain('you can roll back');
  });

  it('renders the agent message as text, never as HTML', async () => {
    fetchMock.mockResolvedValue(
      respond({ attempts: [attempt({ status: 'failed', message: '<img src=x onerror=alert(1)>' })] }),
    );
    const { container } = render(<DeviceRestorePointAttempts deviceId="dev-1" />);
    await screen.findByTestId('restore-point-badge');
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows a loading state before the first response', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => { resolve = r; }));
    render(<DeviceRestorePointAttempts deviceId="dev-1" />);
    expect(screen.getByTestId('restore-point-attempts-loading')).toBeTruthy();
    expect(screen.queryByTestId('restore-point-attempts-empty')).toBeNull();
    resolve(respond({ attempts: [] }));
    await screen.findByTestId('restore-point-attempts-empty');
    expect(screen.queryByTestId('restore-point-attempts-loading')).toBeNull();
  });

  it('shows an error (not an empty list) when the fetch fails, and Retry recovers', async () => {
    fetchMock.mockResolvedValueOnce(respond({}, false, 500));
    render(<DeviceRestorePointAttempts deviceId="dev-1" />);
    expect(await screen.findByTestId('restore-point-attempts-error')).toBeTruthy();
    expect(screen.queryByTestId('restore-point-attempts-empty')).toBeNull();

    fetchMock.mockResolvedValueOnce(respond({ attempts: [attempt()] }));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByTestId('restore-point-badge')).toBeTruthy();
    expect(screen.queryByTestId('restore-point-attempts-error')).toBeNull();
  });

  it('treats a thrown fetch as an error too', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    render(<DeviceRestorePointAttempts deviceId="dev-1" />);
    expect(await screen.findByTestId('restore-point-attempts-error')).toBeTruthy();
  });

  it('loads more with nextBefore and appends without repeating rows', async () => {
    fetchMock.mockResolvedValueOnce(
      respond({
        attempts: [attempt({ requestId: '22222222-2222-4222-8222-222222222222', status: 'created' })],
        nextBefore: 'CURSOR-1',
      }),
    );
    render(<DeviceRestorePointAttempts deviceId="dev-1" />);
    await screen.findByTestId('restore-point-attempt-row-22222222-2222-4222-8222-222222222222');

    fetchMock.mockResolvedValueOnce(
      respond({ attempts: [attempt({ requestId: '11111111-1111-4111-8111-111111111111' })] }),
    );
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));

    await screen.findByTestId('restore-point-attempt-row-11111111-1111-4111-8111-111111111111');
    expect(fetchMock).toHaveBeenLastCalledWith('/devices/dev-1/restore-point-attempts?limit=50&before=CURSOR-1');
    expect(screen.getAllByTestId(/^restore-point-attempt-row-/)).toHaveLength(2);
    // No further cursor: the button is gone.
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });

  it('keeps the loaded rows and offers a retry when load-more fails', async () => {
    fetchMock.mockResolvedValueOnce(respond({ attempts: [attempt()], nextBefore: 'CURSOR-1' }));
    render(<DeviceRestorePointAttempts deviceId="dev-1" />);
    await screen.findByTestId('restore-point-badge');

    fetchMock.mockResolvedValueOnce(respond({}, false, 500));
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(screen.getByTestId('restore-point-attempts-more-error')).toBeTruthy());
    expect(screen.getAllByTestId('restore-point-badge')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /load more/i })).toBeTruthy();
  });

  it('encodes the cursor in the query string', async () => {
    fetchMock.mockResolvedValueOnce(respond({ attempts: [attempt()], nextBefore: 'a+b/c=' }));
    render(<DeviceRestorePointAttempts deviceId="dev-1" />);
    await screen.findByTestId('restore-point-badge');
    fetchMock.mockResolvedValueOnce(respond({ attempts: [] }));
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/devices/dev-1/restore-point-attempts?limit=50&before=${encodeURIComponent('a+b/c=')}`,
    );
  });

  it('links a script attempt to its run via the device hash', async () => {
    fetchMock.mockResolvedValue(
      respond({ attempts: [attempt({ trigger: 'script', scriptExecutionId: 'exec-9' })] }),
    );
    render(<DeviceRestorePointAttempts deviceId="dev-1" />);
    const link = await screen.findByRole('link', { name: /view script run/i });
    expect(link.getAttribute('href')).toBe('#scripts/exec-9');
  });
  it('treats a 200 with an unexpected body as an error, not as an empty ledger', async () => {
    fetchMock.mockResolvedValue(respond({}));
    render(<DeviceRestorePointAttempts deviceId="dev-1" />);
    expect(await screen.findByTestId('restore-point-attempts-error')).toBeTruthy();
    expect(screen.queryByTestId('restore-point-attempts-empty')).toBeNull();
  });

  it('renders an unknown trigger and an unknown status without crashing (version skew)', async () => {
    fetchMock.mockResolvedValue(respond({ attempts: [attempt({ trigger: 'future_trigger', status: 'future_status' })] }));
    render(<DeviceRestorePointAttempts deviceId="dev-1" />);
    expect(await screen.findByText('future_trigger')).toBeTruthy();
    expect(screen.getByTestId('restore-point-badge').getAttribute('data-tone')).toBe('neutral');
  });

  it('does not leave Load more stuck after the device changes mid-request', async () => {
    fetchMock.mockResolvedValueOnce(respond({ attempts: [attempt()], nextBefore: 'C1' }));
    const { rerender } = render(<DeviceRestorePointAttempts deviceId="dev-1" />);
    await screen.findByTestId('restore-point-badge');

    let resolveMore!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { resolveMore = r; }));
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));

    fetchMock.mockResolvedValueOnce(respond({ attempts: [attempt()], nextBefore: 'C2' }));
    rerender(<DeviceRestorePointAttempts deviceId="dev-2" />);
    resolveMore(respond({ attempts: [] }));

    const button = await screen.findByRole('button', { name: /load more/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
