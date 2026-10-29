/**
 * Tool Catalog W06 (#5221) Task C2 — the switch dialog (plan Decisions 3, 4, 5).
 *
 * Every authority the flow gains is accepted affirmatively: nothing pre-ticked,
 * each pre-approval needs a maxTargets, a widened scope and the delegator
 * lifecycle need their own ticks, and Switch is never offered before the shadow
 * is 10 minutes old.
 */
import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowConversionDto, FlowConversionPreviewDto } from '@breeze/shared';

const api = vi.hoisted(() => ({ switchConversion: vi.fn() }));
vi.mock('./conversionApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./conversionApi')>()),
  switchConversion: api.switchConversion,
}));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

import { ActionError } from '@/lib/runAction';
import { SwitchDialog } from './SwitchDialog';

const NOW = Date.parse('2027-01-20T12:00:00Z');
const DAY = 86_400_000;

function conversion(over: Partial<FlowConversionDto> = {}, shadowAgeMs = 8 * DAY): FlowConversionDto {
  return {
    id: 'c-1',
    automationId: 'a-1',
    flowId: 'f-1',
    state: 'shadow',
    fidelity: 'exact',
    findings: [],
    createdAt: new Date(NOW - shadowAgeMs).toISOString(),
    switchAt: null,
    revertAt: null,
    shadow: { runs: 5, divergences: 0, startedAt: new Date(NOW - shadowAgeMs).toISOString(), lastAt: null, lastDivergence: null },
    switchBlockedBy: null,
    ...over,
  };
}

function preview(over: Partial<FlowConversionPreviewDto> = {}): FlowConversionPreviewDto {
  return {
    automationId: 'a-1',
    fidelity: 'exact',
    findings: [],
    document: null,
    preApprovalCandidates: [{ stepId: 'a0_run_script', currentTargetCount: 12 }],
    generatedScripts: [],
    sourceDigest: 'd'.repeat(64),
    documentDigest: 'e'.repeat(64),
    targetCount: 12,
    estimatedMonthlyRuns: 30,
    ...over,
  };
}

function renderDialog(props: Partial<Parameters<typeof SwitchDialog>[0]> = {}) {
  const onSwitched = vi.fn();
  const onStale = vi.fn();
  render(
    <SwitchDialog
      open
      jobName="Nightly cleanup"
      partnerWide={false}
      isWebhook={false}
      conversion={conversion()}
      preview={preview()}
      flowVersion={3}
      onClose={vi.fn()}
      onSwitched={onSwitched}
      onStale={onStale}
      now={() => NOW}
      {...props}
    />,
  );
  return { onSwitched, onStale };
}

const confirm = () => screen.getByTestId('conversion-switch-confirm') as HTMLButtonElement;
const tick = (id: string) => fireEvent.click(screen.getByTestId(id));

beforeEach(() => {
  api.switchConversion.mockReset().mockResolvedValue({ conversion: conversion({ state: 'switched' }) });
});

describe('SwitchDialog', () => {
  it('delegator lifecycle acknowledgement is required', () => {
    renderDialog({ preview: preview({ preApprovalCandidates: [] }) });
    expect(confirm().disabled).toBe(true);
    tick('conversion-switch-accept-delegator');
    expect(confirm().disabled).toBe(false);
  });

  it('switch disabled until the gate or acknowledgement, never before 10 min', () => {
    // Younger than 10 minutes: nothing unlocks it, even when the server gate is silent.
    const { unmount } = render(
      <SwitchDialog
        open jobName="J" partnerWide={false} isWebhook={false} conversion={conversion({}, 5 * 60_000)}
        preview={preview({ preApprovalCandidates: [] })} flowVersion={3} onClose={vi.fn()} onSwitched={vi.fn()} now={() => NOW}
      />,
    );
    expect(screen.getByTestId('conversion-switch-too-new')).toBeTruthy();
    tick('conversion-switch-accept-delegator');
    expect(confirm().disabled).toBe(true);
    expect(screen.queryByTestId('conversion-switch-acknowledge')).toBeNull();
    unmount();

    // Old enough but the evidence gate is unmet: the acknowledgement unlocks it.
    renderDialog({
      conversion: conversion({ switchBlockedBy: 'shadow_too_short' }, 2 * DAY),
      preview: preview({ preApprovalCandidates: [] }),
    });
    tick('conversion-switch-accept-delegator');
    expect(confirm().disabled).toBe(true);
    tick('conversion-switch-acknowledge');
    expect(confirm().disabled).toBe(false);
  });

  it('a hard gate (source changed) cannot be acknowledged', () => {
    renderDialog({ conversion: conversion({ switchBlockedBy: 'source_changed' }), preview: preview({ preApprovalCandidates: [] }) });
    expect(screen.getByTestId('conversion-switch-blocked-source_changed')).toBeTruthy();
    expect(screen.queryByTestId('conversion-switch-acknowledge')).toBeNull();
    tick('conversion-switch-accept-delegator');
    expect(confirm().disabled).toBe(true);
  });

  it('the acknowledgement is sent only when it was needed and ticked', async () => {
    renderDialog({
      conversion: conversion({ switchBlockedBy: 'shadow_divergent' }),
      preview: preview({ preApprovalCandidates: [] }),
    });
    tick('conversion-switch-acknowledge');
    tick('conversion-switch-accept-delegator');
    fireEvent.click(confirm());
    await waitFor(() => expect(api.switchConversion).toHaveBeenCalled());
    expect(api.switchConversion.mock.calls[0]![1]).toMatchObject({ acknowledgeDivergence: true, acceptDelegatorLifecycle: true });
  });

  it('pre-approvals are unticked by default and need maxTargets', async () => {
    const { onSwitched } = renderDialog();
    const box = screen.getByTestId('conversion-switch-preapprove-a0_run_script') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.queryByTestId('conversion-switch-maxtargets-a0_run_script')).toBeNull();

    tick('conversion-switch-accept-delegator');
    expect(confirm().disabled).toBe(false); // no pre-approval: allowed, each run waits for approval

    tick('conversion-switch-preapprove-a0_run_script');
    const input = screen.getByTestId('conversion-switch-maxtargets-a0_run_script');
    expect(confirm().disabled).toBe(true); // ticked without a maxTargets
    for (const bad of ['0', '501', '2.5', 'x']) {
      fireEvent.change(input, { target: { value: bad } });
      expect(confirm().disabled).toBe(true);
    }
    expect(screen.getByText(/frozen|exact devices/i)).toBeTruthy();
    expect(screen.getByText(/worked out fresh on each run/i)).toBeTruthy();
    fireEvent.change(input, { target: { value: '40' } });
    expect(confirm().disabled).toBe(false);

    fireEvent.click(confirm());
    await waitFor(() => expect(onSwitched).toHaveBeenCalled());
    expect(api.switchConversion).toHaveBeenCalledWith('c-1', {
      expectedFlowVersion: 3,
      preApprovals: [{ stepId: 'a0_run_script', maxTargets: 40 }],
      acceptScopeWidening: false,
      acceptDelegatorLifecycle: true,
      acknowledgeDivergence: false,
    });
  });

  it('a partner-wide Job discloses the per-org multiplication', () => {
    renderDialog({ partnerWide: true });
    tick('conversion-switch-preapprove-a0_run_script');
    expect(screen.getByTestId('conversion-switch-perorg')).toBeTruthy();
  });

  it('scope widening checkbox appears with site_ceiling_removed', async () => {
    const { unmount } = render(
      <SwitchDialog
        open jobName="J" partnerWide={false} isWebhook={false} conversion={conversion()}
        preview={preview({ preApprovalCandidates: [] })} flowVersion={3} onClose={vi.fn()} onSwitched={vi.fn()} now={() => NOW}
      />,
    );
    expect(screen.queryByTestId('conversion-switch-accept-scope')).toBeNull();
    unmount();

    renderDialog({
      conversion: conversion({
        fidelity: 'needs_review',
        findings: [{ code: 'site_ceiling_removed', severity: 'review', actionIndex: null, detail: '' }],
      }),
      preview: preview({ preApprovalCandidates: [] }),
    });
    tick('conversion-switch-accept-delegator');
    expect(confirm().disabled).toBe(true);
    tick('conversion-switch-accept-scope');
    expect(confirm().disabled).toBe(false);
    fireEvent.click(confirm());
    await waitFor(() => expect(api.switchConversion).toHaveBeenCalled());
    expect(api.switchConversion.mock.calls[0]![1]).toMatchObject({ acceptScopeWidening: true });
  });

  it('generated scripts are shown with their body and must be accepted', () => {
    renderDialog({
      preview: preview({
        preApprovalCandidates: [],
        generatedScripts: [{ stepId: 'a0_run_script', name: 'Moved from Job "J" — command 1', language: 'bash', body: 'df -h /' }],
      }),
    });
    expect(screen.getByTestId('conversion-switch-scripts').textContent).toContain('df -h /');
    tick('conversion-switch-accept-delegator');
    expect(confirm().disabled).toBe(true);
    tick('conversion-switch-accept-scripts');
    expect(confirm().disabled).toBe(false);
  });

  it('a webhook Job states the URL and body change and that webhook runs always wait', () => {
    renderDialog({ isWebhook: true });
    expect(screen.getByTestId('conversion-switch-webhook').textContent).toMatch(/X-Breeze-Webhook-Token/);
    expect(screen.getByTestId('conversion-switch-webhook-approval')).toBeTruthy();
  });

  it('a switch 422 renders inline with localized copy', async () => {
    api.switchConversion.mockRejectedValue(new ActionError('x', 422, undefined, { error: 'scope_widening_not_accepted' }));
    const { onSwitched } = renderDialog({ preview: preview({ preApprovalCandidates: [] }) });
    tick('conversion-switch-accept-delegator');
    fireEvent.click(confirm());
    const err = await screen.findByTestId('conversion-switch-error-scope_widening_not_accepted');
    expect(err.textContent).toMatch(/wider device scope/i);
    expect(onSwitched).not.toHaveBeenCalled();
  });

  it('an unmapped refusal shows the server message inline (it is not toasted)', async () => {
    api.switchConversion.mockRejectedValue(new ActionError('Permission denied', 403, undefined, { error: 'Permission denied' }));
    renderDialog({ preview: preview({ preApprovalCandidates: [] }) });
    tick('conversion-switch-accept-delegator');
    fireEvent.click(confirm());
    const err = await screen.findByTestId('conversion-switch-error');
    expect(err.textContent).toContain('Permission denied');
  });

  it('the 10-minute floor lifts by itself while the dialog is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let clock = NOW;
      render(
        <SwitchDialog
          open jobName="J" partnerWide={false} isWebhook={false} conversion={conversion({}, 9 * 60_000)}
          preview={preview({ preApprovalCandidates: [] })} flowVersion={3} onClose={vi.fn()} onSwitched={vi.fn()} now={() => clock}
        />,
      );
      tick('conversion-switch-accept-delegator');
      expect(confirm().disabled).toBe(true);
      clock = NOW + 61_000;
      await vi.advanceTimersByTimeAsync(61_000);
      await waitFor(() => expect(confirm().disabled).toBe(false));
      expect(screen.queryByTestId('conversion-switch-too-new')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a 409 automation_disabled renders inline and asks the caller to reload', async () => {
    api.switchConversion.mockRejectedValue(new ActionError('x', 409, undefined, { error: 'automation_disabled' }));
    const { onStale } = renderDialog({ preview: preview({ preApprovalCandidates: [] }) });
    tick('conversion-switch-accept-delegator');
    fireEvent.click(confirm());
    const err = await screen.findByTestId('conversion-switch-error-automation_disabled');
    expect(err.textContent).toMatch(/turn the job on/i);
    expect(onStale).toHaveBeenCalled();
  });
});
