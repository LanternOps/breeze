import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  context: 'none',
  conversionContexts: [] as string[],
  markerContexts: [] as string[],
  convertPartnerLegacy: vi.fn(),
  previewPartnerConversion: vi.fn(),
  retireSource: vi.fn(),
  captureException: vi.fn(),
  executeRows: [] as Array<Record<string, unknown>>,
  updateSet: vi.fn(),
  countRows: [{ rules: 0, watches: 0 }],
}));

vi.mock('../../../db', () => ({
  db: {
    execute: vi.fn(async () => h.executeRows),
    update: vi.fn(() => ({ set: h.updateSet.mockImplementation(() => { h.markerContexts.push(h.context); return { where: vi.fn(async () => undefined) }; }) })),
    select: vi.fn(() => ({ from: vi.fn(async () => h.countRows) })),
  },
  runOutsideDbContext: async (fn: () => unknown) => {
    const previous = h.context; h.context = 'none';
    try { return await fn(); } finally { h.context = previous; }
  },
  withSystemDbAccessContext: async (fn: () => unknown) => {
    if (h.context !== 'none') throw new Error('nested DB context');
    h.context = 'system';
    try { return await fn(); } finally { h.context = 'none'; }
  },
}));
vi.mock('./index', () => ({
  convertPartnerLegacy: h.convertPartnerLegacy,
  previewPartnerConversion: h.previewPartnerConversion,
  retireSource: h.retireSource,
  ConversionError: class extends Error { constructor(readonly code: string, message: string) { super(message); } },
}));
vi.mock('../../sentry', () => ({ captureException: h.captureException }));
vi.mock('../../featureConfigResolver', () => ({ createSystemAuthContext: () => ({ scope: 'system' }) }));

import { runLegacyAlertingRetirement, checkLegacyAlertingRetired, LegacyAlertingUnretiredError, retirePreviewRefusals } from './retirementSweep';
import { ConversionError } from './index';
import type { PartnerConversionPreview } from './types';

beforeEach(() => {
  vi.resetAllMocks();
  h.context = 'none';
  h.conversionContexts = [];
  h.markerContexts = [];
  vi.stubEnv('BREEZE_LEGACY_ALERTING_SWEEP', 'true');
  h.executeRows = [];
  h.countRows = [{ rules: 0, watches: 0 }];
  h.previewPartnerConversion.mockImplementation(async (partnerId: string) => ({
    partnerId, previewHash: 'a'.repeat(64), policies: 0, rows: 0, convertible: 0, unconvertible: [],
  }));
  h.retireSource.mockResolvedValue({ conversionId: 'ledger-1' });
  delete process.env.BREEZE_LEGACY_ALERTING_SWEEP;
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('runLegacyAlertingRetirement (W05d)', () => {
  it('opens conversion transactions outside caller context and writes the marker separately (D30)', async () => {
    h.context = 'request';
    h.executeRows = [{ partner_id: 'p1' }];
    const recordContext = () => { h.conversionContexts.push(h.context); };
    h.previewPartnerConversion.mockImplementationOnce(async () => {
      recordContext();
      return { partnerId: 'p1', previewHash: 'hash', policies: 1, rows: 1, convertible: 0,
        unconvertible: [{ sourceTable: 'config_policy_alert_rules', sourceId: 'r1', name: 'Custom',
          reason: 'unconvertible:custom_condition', policyId: null, policyName: null }] };
    });
    h.convertPartnerLegacy.mockImplementationOnce(async () => { recordContext(); return { converted: 0 }; });
    h.retireSource.mockImplementationOnce(async () => { recordContext(); return { conversionId: 'ledger' }; });
    expect(await runLegacyAlertingRetirement()).toMatchObject({ partners: 1, retired: 1, failed: 0 });
    expect(h.conversionContexts).toEqual(['none', 'none', 'none']);
    expect(h.markerContexts).toEqual(['system']);
    expect(h.context).toBe('request');
  });
  it('sweeps only partners that still own unretired legacy rows and records the marker', async () => {
    h.executeRows = [{ partner_id: 'p1' }, { partner_id: 'p2' }];
    h.previewPartnerConversion.mockResolvedValueOnce({ partnerId: 'p1', previewHash: 'a'.repeat(64), policies: 1,
      rows: 3, convertible: 2, unconvertible: [{ sourceTable: 'config_policy_alert_rules', sourceId: 'r1',
        name: 'Custom', reason: 'unconvertible:custom_condition', policyId: 'pol', policyName: 'Servers' }] });
    h.convertPartnerLegacy.mockResolvedValueOnce({ policies: 1, converted: 2, unconvertible: 1 });
    h.convertPartnerLegacy.mockResolvedValueOnce({ policies: 0, converted: 0, unconvertible: 0 });
    const out = await runLegacyAlertingRetirement();
    expect(h.convertPartnerLegacy).toHaveBeenCalledTimes(2);
    expect(h.convertPartnerLegacy).toHaveBeenCalledWith('p1', 'a'.repeat(64), expect.objectContaining({ scope: 'system' }));
    expect(h.retireSource).toHaveBeenCalledWith('config_policy_alert_rules', 'r1', 'unconvertible:custom_condition', expect.objectContaining({ scope: 'system' }));
    expect(out).toMatchObject({ partners: 2, converted: 2, retired: 1, failed: 0 });
    expect(h.updateSet).toHaveBeenCalledTimes(2);
  });
  it('one partner failing never blocks the rest, and is reported to Sentry', async () => {
    h.executeRows = [{ partner_id: 'p1' }, { partner_id: 'p2' }];
    h.convertPartnerLegacy.mockRejectedValueOnce(new Error('boom'));
    h.convertPartnerLegacy.mockResolvedValueOnce({ policies: 0, converted: 1, unconvertible: 0 });
    const out = await runLegacyAlertingRetirement();
    expect(out).toMatchObject({ partners: 1, failed: 1, converted: 1 });
    expect(h.captureException).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({ area: 'legacy_alerting_sweep', partnerId: 'p1' }));
  });
  it('a blocked partner preview cannot convert, retire or record a completed sweep', async () => {
    h.executeRows = [{ partner_id: 'p1' }];
    const error = new Error('CONVERSION_PREREQUISITE_MISSING');
    h.previewPartnerConversion.mockRejectedValueOnce(error);
    const out = await runLegacyAlertingRetirement();
    expect(out).toMatchObject({ partners: 0, converted: 0, retired: 0, failed: 1 });
    expect(h.convertPartnerLegacy).not.toHaveBeenCalled();
    expect(h.retireSource).not.toHaveBeenCalled();
    expect(h.updateSet).not.toHaveBeenCalled();
    expect(h.captureException).toHaveBeenCalledWith(error, undefined, expect.objectContaining({ partnerId: 'p1' }));
  });
  it('BREEZE_LEGACY_ALERTING_SWEEP=false skips conversion but still counts', async () => {
    process.env.BREEZE_LEGACY_ALERTING_SWEEP = 'false';
    h.executeRows = [{ partner_id: 'p1' }];
    h.countRows = [{ rules: 3, watches: 0 }];
    const out = await runLegacyAlertingRetirement();
    expect(h.convertPartnerLegacy).not.toHaveBeenCalled();
    expect(out.remaining).toEqual({ configPolicyAlertRules: 3, configPolicyMonitoringWatches: 0 });
  });
});

describe('retirePreviewRefusals', () => {
  const item = { sourceTable: 'config_policy_alert_rules' as const, sourceId: 'r1', name: 'Custom',
    reason: 'unconvertible:custom_condition', policyId: null, policyName: null };
  const preview = { partnerId: 'p1', previewHash: 'a'.repeat(64), policies: 0, rows: 1,
    convertible: 0, unconvertible: [item] } satisfies PartnerConversionPreview;
  it('keeps the machine reason verbatim and returns only successful retirements', async () => {
    expect(await retirePreviewRefusals(preview, { scope: 'system' } as never)).toEqual([
      { sourceTable: item.sourceTable, sourceId: 'r1', name: 'Custom', reason: item.reason, policyId: null },
    ]);
    expect(h.retireSource.mock.calls[0]![2]).toBe('unconvertible:custom_condition');
  });
  it('treats already_converted as a completed race without a duplicate report', async () => {
    h.retireSource.mockRejectedValueOnce(new ConversionError('already_converted', 'already completed'));
    expect(await retirePreviewRefusals(preview, { scope: 'system' } as never)).toEqual([]);
  });
  it('does not swallow other errors', async () => {
    h.retireSource.mockRejectedValueOnce(new Error('connection failed'));
    await expect(retirePreviewRefusals(preview, { scope: 'system' } as never)).rejects.toThrow('connection failed');
  });
  it('never retires broad workflows, even from an obsolete preview', async () => {
    const stale = { ...preview, unconvertible: [{ ...item, sourceTable: 'config_policy_automations' as const,
      reason: 'unconvertible:alert_workflow_kept' }] };
    expect(await retirePreviewRefusals(stale, { scope: 'system' } as never)).toEqual([]);
    expect(h.retireSource).not.toHaveBeenCalled();
  });
  it('retires only the five removed-runtime sources in a mixed legacy/network preview', async () => {
    const legacyTables = ['config_policy_alert_rules', 'config_policy_monitoring_watches',
      'alert_templates', 'automations', 'config_policy_automations'] as const;
    const legacy = legacyTables.map((sourceTable, index) => ({ ...item, sourceTable, sourceId: `legacy-${index}` }));
    const network = { ...item, sourceTable: 'network_monitors' as const, sourceId: 'network-1',
      reason: 'unconvertible:multiple_network_rules' };
    const mixed: PartnerConversionPreview = { ...preview, rows: legacy.length + 1,
      unconvertible: [network, ...legacy] };
    const retired = await retirePreviewRefusals(mixed, { scope: 'system' } as never);
    expect(retired.map(row => row.sourceTable)).toEqual([...legacyTables]);
    expect(h.retireSource.mock.calls.map(([table, id, reason]) => ({ table, id, reason })))
      .toEqual(legacy.map(row => ({ table: row.sourceTable, id: row.sourceId, reason: row.reason })));
    expect(h.retireSource).not.toHaveBeenCalledWith('network_monitors', expect.anything(), expect.anything(), expect.anything());
  });
});

describe('checkLegacyAlertingRetired (W05d)', () => {
  it('is silent at zero', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await checkLegacyAlertingRetired();
    expect(err).not.toHaveBeenCalled();
    expect(h.captureException).not.toHaveBeenCalled();
  });
  it('logs at error level and reports to Sentry when anything is unretired — and never throws', async () => {
    h.countRows = [{ rules: 2, watches: 5 }];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const remaining = await checkLegacyAlertingRetired();
    expect(remaining).toEqual({ configPolicyAlertRules: 2, configPolicyMonitoringWatches: 5 });
    expect(err).toHaveBeenCalledWith(expect.stringContaining('2 config_policy_alert_rules'));
    expect(h.captureException).toHaveBeenCalledWith(expect.any(LegacyAlertingUnretiredError), undefined, expect.objectContaining({ area: 'legacy_alerting_unretired' }));
  });
});
