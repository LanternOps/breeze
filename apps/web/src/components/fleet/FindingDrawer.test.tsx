import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getFindingMock, patchFindingMock } = vi.hoisted(() => ({
  getFindingMock: vi.fn(),
  patchFindingMock: vi.fn(),
}));

vi.mock('@/services/fleetFindings', () => ({
  listFindings: vi.fn(),
  getFinding: getFindingMock,
  patchFinding: patchFindingMock,
}));

const { handleActionErrorMock } = vi.hoisted(() => ({ handleActionErrorMock: vi.fn() }));
vi.mock('@/lib/runAction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runAction')>();
  return { ...actual, handleActionError: handleActionErrorMock };
});

import FindingDrawer from './FindingDrawer';
import type { FleetFindingDetail } from '@/services/fleetFindings';

const FINDING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const RUN_ID = 'rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr';

function detail(overrides: Partial<FleetFindingDetail> = {}): FleetFindingDetail {
  return {
    id: FINDING_ID,
    orgId: '11111111-1111-4111-8111-111111111111',
    orgName: 'Acme Corp',
    kind: 'reliability_offenders',
    semanticKey: 'crash_loop',
    status: 'open',
    severity: 'error',
    title: 'Repeat crashers in the fleet',
    summary: 'Three devices crashed more than five times this week.',
    evidence: { window: '7d', crashThreshold: 5 },
    deviceCount: 3,
    revision: 2,
    firstSeenAt: '2026-08-01T10:00:00.000Z',
    lastSeenAt: '2026-08-07T10:00:00.000Z',
    acknowledgedAt: null,
    acknowledgedBy: null,
    dismissedAt: null,
    dismissedBy: null,
    dismissNotes: null,
    resolvedAt: null,
    resolutionReason: null,
    members: [
      {
        deviceId: DEVICE_ID,
        hostname: 'WS-ACME-01',
        displayName: null,
        siteId: '33333333-3333-4333-8333-333333333333',
        sourceKind: 'reliability_score',
        osType: 'windows',
        memberEvidence: { crashes: 9 },
        firstSeenAt: '2026-08-01T10:00:00.000Z',
        lastSeenAt: '2026-08-07T10:00:00.000Z',
      },
    ],
    runs: [
      {
        id: RUN_ID,
        actionKind: 'command',
        scriptId: null,
        commandType: 'restart_service',
        status: 'partial',
        targetCount: 3,
        succeededCount: 2,
        failedCount: 1,
        skippedCount: 0,
        createdAt: '2026-08-06T10:00:00.000Z',
        startedAt: '2026-08-06T10:00:05.000Z',
        completedAt: '2026-08-06T10:02:00.000Z',
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  getFindingMock.mockResolvedValue(detail());
  patchFindingMock.mockImplementation(async (id: string, action: string) =>
    detail({ id, status: action === 'acknowledge' ? 'acknowledged' : 'dismissed' })
  );
});

describe('FindingDrawer content', () => {
  it('renders the summary, evidence, members and run history', async () => {
    render(<FindingDrawer findingId={FINDING_ID} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('finding-drawer')).toBeTruthy());
    expect(screen.getByText('Repeat crashers in the fleet')).toBeTruthy();
    expect(screen.getByText(/Three devices crashed/)).toBeTruthy();

    expect(screen.getByTestId('finding-evidence').textContent).toContain('crashThreshold');

    const member = screen.getByTestId(`finding-member-${DEVICE_ID}`);
    expect(member.textContent).toContain('WS-ACME-01');
    expect(member.querySelector('a')?.getAttribute('href')).toBe(`/devices/${DEVICE_ID}`);

    const run = screen.getByTestId(`finding-run-${RUN_ID}`);
    expect(run.textContent).toContain('2');
    expect(run.textContent).toContain('1');
  });

  it('surfaces a load failure instead of rendering an empty drawer', async () => {
    getFindingMock.mockRejectedValue(new Error('nope'));
    render(<FindingDrawer findingId={FINDING_ID} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('finding-drawer-error')).toBeTruthy());
  });

  it('renders a remediate button carrying the device count and invokes onRemediate', async () => {
    const onRemediate = vi.fn();
    render(<FindingDrawer findingId={FINDING_ID} onClose={vi.fn()} onRemediate={onRemediate} />);

    await waitFor(() => expect(screen.getByTestId('finding-remediate')).toBeTruthy());
    const button = screen.getByTestId('finding-remediate');
    expect(button.textContent).toContain('3');

    fireEvent.click(button);
    expect(onRemediate).toHaveBeenCalledTimes(1);
    expect(onRemediate.mock.calls[0][0]).toMatchObject({ id: FINDING_ID });
  });
});

describe('FindingDrawer lifecycle', () => {
  it('acknowledges an open finding and reports the new status upward', async () => {
    const onStatusChange = vi.fn();
    render(
      <FindingDrawer findingId={FINDING_ID} onClose={vi.fn()} onStatusChange={onStatusChange} />
    );
    await waitFor(() => expect(screen.getByTestId('finding-ack')).toBeTruthy());

    fireEvent.click(screen.getByTestId('finding-ack'));

    await waitFor(() => expect(patchFindingMock).toHaveBeenCalledWith(FINDING_ID, 'acknowledge'));
    await waitFor(() =>
      expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'acknowledged' }))
    );
    await waitFor(() => expect(screen.queryByTestId('finding-ack')).toBeNull());
  });

  it('requires notes before a dismiss can be confirmed', async () => {
    render(<FindingDrawer findingId={FINDING_ID} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('finding-dismiss')).toBeTruthy());

    fireEvent.click(screen.getByTestId('finding-dismiss'));

    const confirm = screen.getByTestId('finding-dismiss-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(patchFindingMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('finding-dismiss-notes'), {
      target: { value: 'Known false positive on the lab subnet' },
    });
    expect((screen.getByTestId('finding-dismiss-confirm') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('finding-dismiss-confirm'));
    await waitFor(() =>
      expect(patchFindingMock).toHaveBeenCalledWith(
        FINDING_ID,
        'dismiss',
        'Known false positive on the lab subnet'
      )
    );
  });

  it('offers reopen for a dismissed finding and not for an open one', async () => {
    getFindingMock.mockResolvedValue(detail({ status: 'dismissed', dismissNotes: 'not real' }));
    render(<FindingDrawer findingId={FINDING_ID} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('finding-reopen')).toBeTruthy());
    expect(screen.queryByTestId('finding-ack')).toBeNull();

    fireEvent.click(screen.getByTestId('finding-reopen'));
    await waitFor(() => expect(patchFindingMock).toHaveBeenCalledWith(FINDING_ID, 'reopen'));
  });

  it('does not offer lifecycle actions on a resolved finding', async () => {
    getFindingMock.mockResolvedValue(detail({ status: 'resolved', resolvedAt: '2026-08-07T00:00:00.000Z' }));
    render(<FindingDrawer findingId={FINDING_ID} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('finding-drawer')).toBeTruthy());
    expect(screen.queryByTestId('finding-ack')).toBeNull();
    expect(screen.queryByTestId('finding-dismiss')).toBeNull();
    expect(screen.queryByTestId('finding-reopen')).toBeNull();
  });

  it('hides remediate on a resolved finding and explains the closed state', async () => {
    getFindingMock.mockResolvedValue(
      detail({
        status: 'resolved',
        resolvedAt: '2026-08-07T00:00:00.000Z',
        resolutionReason: 'crash rate returned to baseline',
      })
    );
    render(<FindingDrawer findingId={FINDING_ID} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('finding-resolved-note')).toBeTruthy());
    expect(screen.queryByTestId('finding-remediate')).toBeNull();
    expect(screen.getByTestId('finding-resolved-reason').textContent).toContain(
      'crash rate returned to baseline'
    );
  });

  it('hides remediate on a dismissed finding', async () => {
    getFindingMock.mockResolvedValue(detail({ status: 'dismissed', dismissNotes: 'not real' }));
    render(<FindingDrawer findingId={FINDING_ID} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('finding-reopen')).toBeTruthy());
    expect(screen.queryByTestId('finding-remediate')).toBeNull();
    expect(screen.queryByTestId('finding-resolved-note')).toBeNull();
  });

  it('disables remediate and explains why when a finding has zero devices left', async () => {
    getFindingMock.mockResolvedValue(detail({ status: 'open', deviceCount: 0, members: [] }));
    render(<FindingDrawer findingId={FINDING_ID} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('finding-remediate')).toBeTruthy());
    const button = screen.getByTestId('finding-remediate') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBe('finding-remediate-disabled-reason');
    expect(screen.getByTestId('finding-remediate-disabled-reason')).toBeTruthy();
  });

  it('routes a lifecycle failure through handleActionError rather than swallowing it', async () => {
    patchFindingMock.mockRejectedValue(new Error('server said no'));
    render(<FindingDrawer findingId={FINDING_ID} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('finding-ack')).toBeTruthy());

    fireEvent.click(screen.getByTestId('finding-ack'));

    await waitFor(() => expect(handleActionErrorMock).toHaveBeenCalledTimes(1));
    // the finding stays in its pre-mutation state
    expect(screen.getByTestId('finding-ack')).toBeTruthy();
  });
});
