import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetDesignApplyPreview, FleetDesignApplyResult, FleetDesignRollbackResult } from '@breeze/shared';
import ApplyDrawer from './ApplyDrawer';

const previewApplyMock = vi.fn();
const applyMock = vi.fn();
const rollbackMock = vi.fn();

vi.mock('@/lib/api/fleetDesign', () => ({
  previewApply: (...args: unknown[]) => previewApplyMock(...args),
  apply: (...args: unknown[]) => applyMock(...args),
  rollback: (...args: unknown[]) => rollbackMock(...args),
}));

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const EMPTY_PREVIEW: FleetDesignApplyPreview = {
  functions: [],
  policies: [],
  retired: [],
  roleCorrections: [],
  alreadyApplied: [],
  blockers: [],
};

const EMPTY_BASE = { functions: [], monitoring: [], retired: [], automation: [], legacy: [], roleCorrections: [] };

describe('ApplyDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables Confirm when nothing is selected', async () => {
    previewApplyMock.mockResolvedValue(jsonResponse(EMPTY_PREVIEW));
    render(
      <ApplyDrawer open reportRunId="run-1" approvalBase={EMPTY_BASE} onClose={vi.fn()} onApplied={vi.fn()} />,
    );

    await waitFor(() => expect(previewApplyMock).toHaveBeenCalled());
    expect(screen.getByTestId('fleet-design-apply-drawer-nothing-selected')).toBeTruthy();
    expect((screen.getByTestId('fleet-design-apply-drawer-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows displacements and keeps Confirm disabled until every one is accepted', async () => {
    const preview: FleetDesignApplyPreview = {
      ...EMPTY_PREVIEW,
      policies: [
        {
          functionKey: 'workstation',
          policyName: 'Fleet Design: Workstation',
          watchCount: 1,
          ruleCount: 0,
          displaces: [
            { policyId: 'policy-a', policyName: 'Old Monitoring', featureType: 'monitoring', deviceCount: 4 },
            { policyId: 'policy-b', policyName: 'Old Alerts', featureType: 'alert_rule', deviceCount: 4 },
          ],
        },
      ],
    };
    previewApplyMock.mockResolvedValue(jsonResponse(preview));
    const base = { ...EMPTY_BASE, monitoring: ['monitoring:workstation:watch:0'], functions: ['workstation'] };
    render(<ApplyDrawer open reportRunId="run-1" approvalBase={base} onClose={vi.fn()} onApplied={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('fleet-design-apply-drawer-accept-policy-a')).toBeTruthy());
    expect((screen.getByTestId('fleet-design-apply-drawer-confirm') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('fleet-design-apply-drawer-accept-policy-a'));
    expect((screen.getByTestId('fleet-design-apply-drawer-confirm') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('fleet-design-apply-drawer-accept-policy-b'));
    expect((screen.getByTestId('fleet-design-apply-drawer-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('posts the approval body with displacementsAccepted exactly matching what was checked', async () => {
    const preview: FleetDesignApplyPreview = {
      ...EMPTY_PREVIEW,
      policies: [
        {
          functionKey: 'workstation',
          policyName: 'Fleet Design: Workstation',
          watchCount: 1,
          ruleCount: 0,
          displaces: [{ policyId: 'policy-a', policyName: 'Old Monitoring', featureType: 'monitoring', deviceCount: 4 }],
        },
      ],
    };
    previewApplyMock.mockResolvedValue(jsonResponse(preview));
    const result: FleetDesignApplyResult = { applied: ['functions:workstation'], skipped: [], partial: null, rollbackAvailable: false };
    applyMock.mockResolvedValue(jsonResponse(result));

    const base = { ...EMPTY_BASE, monitoring: ['monitoring:workstation:watch:0'], functions: ['workstation'] };
    render(<ApplyDrawer open reportRunId="run-1" approvalBase={base} onClose={vi.fn()} onApplied={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('fleet-design-apply-drawer-accept-policy-a')).toBeTruthy());
    fireEvent.click(screen.getByTestId('fleet-design-apply-drawer-accept-policy-a'));
    fireEvent.click(screen.getByTestId('fleet-design-apply-drawer-confirm'));

    await waitFor(() => expect(applyMock).toHaveBeenCalled());
    expect(applyMock).toHaveBeenCalledWith('run-1', {
      functions: ['workstation'],
      monitoring: ['monitoring:workstation:watch:0'],
      retired: [],
      automation: [],
      legacy: [],
      roleCorrections: [],
      displacementsAccepted: ['policy-a'],
    });
  });

  it('offers a rollback button on a partial apply result', async () => {
    previewApplyMock.mockResolvedValue(jsonResponse(EMPTY_PREVIEW));
    const partialResult: FleetDesignApplyResult = {
      applied: ['functions:workstation'],
      skipped: [],
      partial: { failedStep: 3, reason: 'policy_create_failed' },
      rollbackAvailable: true,
    };
    applyMock.mockResolvedValue(jsonResponse(partialResult));
    const rollbackResult: FleetDesignRollbackResult = { rolledBack: ['functions:workstation'], refused: [] };
    rollbackMock.mockResolvedValue(jsonResponse(rollbackResult));

    const base = { ...EMPTY_BASE, functions: ['workstation'] };
    const onApplied = vi.fn();
    render(<ApplyDrawer open reportRunId="run-1" approvalBase={base} onClose={vi.fn()} onApplied={onApplied} />);

    await waitFor(() => expect(previewApplyMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('fleet-design-apply-drawer-confirm'));

    await waitFor(() => expect(screen.getByTestId('fleet-design-apply-drawer-rollback')).toBeTruthy());
    fireEvent.click(screen.getByTestId('fleet-design-apply-drawer-rollback'));

    await waitFor(() => expect(rollbackMock).toHaveBeenCalledWith('run-1'));
    await waitFor(() => expect(screen.getByTestId('fleet-design-apply-drawer-rollback-result')).toBeTruthy());
    expect(onApplied).toHaveBeenCalled();
  });

  it('blocks confirm and shows the reasons when preview reports blockers', async () => {
    const preview: FleetDesignApplyPreview = {
      ...EMPTY_PREVIEW,
      blockers: [{ itemRef: 'retired:0', reason: 'retired_item_not_found' }],
    };
    previewApplyMock.mockResolvedValue(jsonResponse(preview));
    const base = { ...EMPTY_BASE, retired: ['retired:0'] };
    render(<ApplyDrawer open reportRunId="run-1" approvalBase={base} onClose={vi.fn()} onApplied={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('fleet-design-apply-drawer-blockers')).toBeTruthy());
    expect((screen.getByTestId('fleet-design-apply-drawer-confirm') as HTMLButtonElement).disabled).toBe(true);
  });
});
