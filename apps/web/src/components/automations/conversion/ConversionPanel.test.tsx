/**
 * Tool Catalog W06 (#5221) Task C2 — the per-Job conversion panel, the fidelity
 * badge and the R1 banner.
 */
import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowConversionDto, FlowConversionPreviewDto } from '@breeze/shared';

const api = vi.hoisted(() => ({
  previewConversion: vi.fn(),
  getConversion: vi.fn(),
  createConversion: vi.fn(),
  createConversionsBulk: vi.fn(),
  revertConversion: vi.fn(),
  switchConversion: vi.fn(),
}));
vi.mock('./conversionApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./conversionApi')>()),
  ...api,
}));
const flowsApi = vi.hoisted(() => ({ getFlow: vi.fn() }));
vi.mock('../../flows/api', () => flowsApi);
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

import { ConversionPanel, parseConvertHash } from './ConversionPanel';
import { FidelityBadge } from './FidelityBadge';
import { JobsMigrationBanner } from './JobsMigrationBanner';

const JOB = { id: 'a-1', name: 'Nightly cleanup', orgId: 'o-1', triggerType: 'schedule' };
const OLD = new Date(Date.now() - 8 * 86_400_000).toISOString();

function preview(over: Partial<FlowConversionPreviewDto> = {}): FlowConversionPreviewDto {
  return {
    automationId: 'a-1',
    fidelity: 'exact',
    findings: [],
    document: {
      version: 1,
      name: 'Nightly cleanup',
      trigger: { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' },
      inputs: [],
      steps: [
        {
          id: 'a0_run_script',
          tool: 'run_script_on_targets',
          input: { scriptId: 's-1', target: { type: 'all' }, whenOffline: 'queue' },
          approval: 'default',
          onFailure: 'stop',
          timeoutSec: 600,
        },
      ],
    } as FlowConversionPreviewDto['document'],
    preApprovalCandidates: [{ stepId: 'a0_run_script', currentTargetCount: 3 }],
    generatedScripts: [],
    sourceDigest: 'd'.repeat(64),
    documentDigest: 'e'.repeat(64),
    targetCount: 3,
    estimatedMonthlyRuns: 30,
    ...over,
  };
}

function conversion(over: Partial<FlowConversionDto> = {}): FlowConversionDto {
  return {
    id: 'c-1', automationId: 'a-1', flowId: 'f-1', state: 'shadow', fidelity: 'exact', findings: [],
    createdAt: OLD, switchAt: null, revertAt: null,
    shadow: { runs: 4, divergences: 0, startedAt: OLD, lastAt: null, lastDivergence: null },
    switchBlockedBy: null,
    ...over,
  };
}

function flowDetail() {
  const doc = preview().document!;
  return {
    flow: { id: 'f-1', definitionVersion: 2, definition: doc },
    validation: { valid: true, effectiveTier: 3, issues: [], steps: [{ id: 'a0_run_script', tool: 'run_script_on_targets', source: 'builtin', tier: 3, approval: 'default' }] },
  };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  flowsApi.getFlow.mockReset().mockResolvedValue(flowDetail());
  api.previewConversion.mockResolvedValue(preview());
});

describe('parseConvertHash', () => {
  it('reads #convert-<id> and ignores anything else', () => {
    expect(parseConvertHash('convert-a-1')).toBe('a-1');
    expect(parseConvertHash('convert-')).toBeUndefined();
    expect(parseConvertHash('webhooks')).toBeUndefined();
  });
});

describe('FidelityBadge', () => {
  it('badge shows the blocker in words', () => {
    render(
      <FidelityBadge
        fidelity="unconvertible"
        findings={[
          { code: 'queued_is_success', severity: 'info', actionIndex: 0, detail: '' },
          { code: 'compliance_remediation_target', severity: 'blocker', actionIndex: null, detail: '' },
        ]}
      />,
    );
    const badge = screen.getByTestId('conversion-fidelity-badge');
    expect(badge.textContent).toContain("Can't move yet");
    expect(badge.textContent).toContain('Used for compliance remediation');
    expect(badge.textContent).not.toContain('compliance_remediation_target');
  });

  it.each([['exact', 'Exact'], ['needs_review', 'Needs review']] as const)('%s reads %s with no blocker line', (f, label) => {
    render(<FidelityBadge fidelity={f} findings={[]} />);
    expect(screen.getByTestId('conversion-fidelity-badge').textContent).toBe(label);
    expect(screen.queryByTestId('conversion-fidelity-blocker')).toBeNull();
  });
});

describe('ConversionPanel', () => {
  it('an unconverted Job shows the preview fidelity, findings and steps, and offers Start shadow', async () => {
    api.previewConversion.mockResolvedValue(preview({
      fidelity: 'needs_review',
      findings: [{ code: 'command_becomes_script', severity: 'review', actionIndex: 0, detail: '' }],
    }));
    api.createConversion.mockResolvedValue(conversion());
    api.getConversion.mockResolvedValue(conversion());
    const onChanged = vi.fn();
    render(<ConversionPanel job={JOB} conversionId={null} canWrite onClose={vi.fn()} onChanged={onChanged} />);
    expect(await screen.findByTestId('conversion-finding-command_becomes_script')).toBeTruthy();
    expect(screen.getByTestId('conversion-fidelity-badge').textContent).toBe('Needs review');
    expect(screen.getByTestId('flow-step-builtin-a0_run_script').textContent).toMatch(/Run a script on devices/);

    fireEvent.click(screen.getByTestId('conversion-start-shadow'));
    await waitFor(() => expect(api.createConversion).toHaveBeenCalledWith('a-1', 'd'.repeat(64)));
    expect(onChanged).toHaveBeenCalled();
    expect(await screen.findByTestId('conversion-shadow')).toBeTruthy();
  });

  it('an unconvertible Job offers no Start shadow', async () => {
    api.previewConversion.mockResolvedValue(preview({
      fidelity: 'unconvertible',
      document: null,
      findings: [{ code: 'deploy_software_unmapped', severity: 'blocker', actionIndex: 1, detail: '' }],
    }));
    render(<ConversionPanel job={JOB} conversionId={null} canWrite onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByTestId('conversion-finding-deploy_software_unmapped')).toBeTruthy();
    expect(screen.queryByTestId('conversion-start-shadow')).toBeNull();
  });

  it('a shadow shows its counters and opens the switch dialog', async () => {
    api.getConversion.mockResolvedValue(conversion({
      shadow: { runs: 2, divergences: 1, startedAt: OLD, lastAt: OLD, lastDivergence: { kind: 'target_set_mismatch', at: OLD, detail: '' } },
      switchBlockedBy: 'shadow_divergent',
    }));
    render(<ConversionPanel job={JOB} conversionId="c-1" canWrite onClose={vi.fn()} onChanged={vi.fn()} />);
    expect((await screen.findByTestId('conversion-shadow-runs')).textContent).toBe('2');
    expect(screen.getByTestId('conversion-shadow-divergences').textContent).toBe('1');
    expect(screen.getByTestId('conversion-shadow-last-divergence').textContent).toMatch(/different devices/);
    expect(screen.getByTestId('conversion-gate-shadow_divergent')).toBeTruthy();
    fireEvent.click(await screen.findByTestId('conversion-open-switch'));
    expect(await screen.findByTestId('conversion-switch-dialog')).toBeTruthy();
    expect(flowsApi.getFlow).toHaveBeenCalledWith('f-1');
  });

  it('revert confirms', async () => {
    api.getConversion.mockResolvedValue(conversion({ state: 'switched', switchAt: OLD }));
    api.revertConversion.mockResolvedValue({ conversion: conversion({ state: 'reverted' }) });
    const onChanged = vi.fn();
    render(<ConversionPanel job={JOB} conversionId="c-1" canWrite onClose={vi.fn()} onChanged={onChanged} />);
    expect(await screen.findByTestId('conversion-switched-note')).toBeTruthy();
    expect(screen.getByTestId('conversion-flow-link').getAttribute('href')).toBe('/flows/f-1');

    fireEvent.click(screen.getByTestId('conversion-open-revert'));
    expect(api.revertConversion).not.toHaveBeenCalled(); // the click only opens the confirmation
    fireEvent.click(await screen.findByTestId('conversion-revert-confirm'));
    await waitFor(() => expect(api.revertConversion).toHaveBeenCalledWith('c-1'));
    expect(onChanged).toHaveBeenCalled();
  });

  it('no write permission hides actions', async () => {
    api.getConversion.mockResolvedValue(conversion({ state: 'switched', switchAt: OLD }));
    render(<ConversionPanel job={JOB} conversionId="c-1" canWrite={false} onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByTestId('conversion-switched-note')).toBeTruthy();
    expect(screen.queryByTestId('conversion-actions')).toBeNull();
    expect(screen.queryByTestId('conversion-open-revert')).toBeNull();
  });

  it('a load failure is shown, not swallowed', async () => {
    api.previewConversion.mockRejectedValue(new Error('Request failed (500)'));
    render(<ConversionPanel job={JOB} conversionId={null} canWrite onClose={vi.fn()} onChanged={vi.fn()} />);
    expect((await screen.findByTestId('conversion-panel-error')).textContent).toContain('500');
  });
});

describe('JobsMigrationBanner', () => {
  it('says Jobs are moving and starts shadows for the selected org only on click', async () => {
    api.createConversionsBulk.mockResolvedValue({ created: 2, skipped: { compliance_remediation_target: 1 } });
    const onConverted = vi.fn();
    render(<JobsMigrationBanner canWrite orgId="o-1" onConverted={onConverted} />);
    const banner = screen.getByTestId('jobs-migration-banner');
    expect(banner.textContent).toContain('Jobs are moving to Flows.');
    expect(api.createConversionsBulk).not.toHaveBeenCalled();
    fireEvent.click(within(banner).getByTestId('jobs-migration-convert-all'));
    await waitFor(() => expect(api.createConversionsBulk).toHaveBeenCalledWith({ ownerScope: 'organization', orgId: 'o-1' }));
    expect((await screen.findByTestId('jobs-migration-summary')).textContent).toMatch(/2.*1/);
    expect(onConverted).toHaveBeenCalled();
  });

  it('no write permission hides the bulk action', () => {
    render(<JobsMigrationBanner canWrite={false} orgId="o-1" onConverted={vi.fn()} />);
    expect(screen.queryByTestId('jobs-migration-convert-all')).toBeNull();
  });
});
