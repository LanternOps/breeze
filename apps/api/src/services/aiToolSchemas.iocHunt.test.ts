/**
 * #6268: toolInputSchemas.ioc_hunt is the enforced shape on the chat and MCP
 * paths; its superRefine is the only per-action required-key check.
 */
import { describe, expect, it } from 'vitest';
import { iocHuntShape, toolInputSchemas } from './aiToolSchemas';
import { IOC_HUNT_ACTIONS } from './iocHuntActions';

const schema = toolInputSchemas.ioc_hunt!;
const ORG = '11111111-1111-4111-8111-111111111111';
const SET = '22222222-2222-4222-8222-222222222222';
const SWEEP = '33333333-3333-4333-8333-333333333333';
const DIGEST = 'd'.repeat(64);

const VALID: Record<(typeof IOC_HUNT_ACTIONS)[number], Record<string, unknown>> = {
  list_rule_sets: {},
  preview_sweep: { orgId: ORG, ruleSetIds: [SET], scope: { kind: 'all' }, scanType: 'quick' },
  list_sweeps: { page: 2, limit: 10 },
  sweep_status: { sweepId: SWEEP },
  sweep: { orgId: ORG, ruleSetIds: [SET], scope: { kind: 'all' }, scanType: 'quick', expectedDeviceCount: 0, previewDigest: DIGEST },
  cancel_sweep: { sweepId: SWEEP },
  import_iocs: { ruleSetId: SET, label: 'Advisory 7', iocs: [{ kind: 'md5', value: 'f'.repeat(32) }] },
};
const REQUIRED: Record<string, string[]> = {
  preview_sweep: ['orgId', 'ruleSetIds', 'scope', 'scanType'],
  sweep: ['orgId', 'ruleSetIds', 'scope', 'scanType', 'expectedDeviceCount', 'previewDigest'],
  sweep_status: ['sweepId'],
  cancel_sweep: ['sweepId'],
  import_iocs: ['ruleSetId', 'iocs', 'label'],
};

describe('toolInputSchemas.ioc_hunt (#6268)', () => {
  it('accepts a minimal valid input for every action (expectedDeviceCount 0 included)', () => {
    for (const action of IOC_HUNT_ACTIONS) {
      expect(schema.safeParse({ action, ...VALID[action] }).success, action).toBe(true);
    }
  });

  it('refuses each action without each of its required keys, at that key', () => {
    for (const [action, keys] of Object.entries(REQUIRED)) {
      for (const key of keys) {
        const input: Record<string, unknown> = { action, ...VALID[action as keyof typeof VALID] };
        delete input[key];
        const r = schema.safeParse(input);
        expect(r.success, `${action} without ${key}`).toBe(false);
        expect(r.error!.issues.some((i) => i.path[0] === key), `${action} without ${key}`).toBe(true);
      }
    }
  });

  it('refuses malformed values', () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['sweep', { previewDigest: 'xyz' }],
      ['sweep', { expectedDeviceCount: -1 }],
      ['sweep', { expectedDeviceCount: 1.5 }],
      ['sweep', { scope: { kind: 'sites', siteIds: [] } }],
      ['import_iocs', { iocs: [] }],
      ['import_iocs', { iocs: [{ kind: 'md5', value: 'x', extra: 1 }] }],
      ['import_iocs', { iocs: [{ kind: 'url', value: 'x' }] }],
      ['list_sweeps', { limit: 101 }],
    ];
    for (const [action, patch] of bad) {
      expect(schema.safeParse({ action, ...VALID[action as keyof typeof VALID], ...patch }).success, `${action} ${JSON.stringify(patch)}`).toBe(false);
    }
    expect(schema.safeParse({ action: 'delete_everything' }).success).toBe(false);
  });

  it('custom-scan paths go through the default AI path restriction', () => {
    const custom = { action: 'sweep', ...VALID.sweep, scanType: 'custom' };
    expect(schema.safeParse({ ...custom, paths: ['C:\\Temp'] }).success).toBe(true);
    expect(schema.safeParse({ ...custom, paths: ['C:\\Windows\\System32\\config\\SAM'] }).success).toBe(false);
  });

  it('declares exactly the seven actions', () => {
    expect(iocHuntShape.action.options).toEqual([...IOC_HUNT_ACTIONS]);
  });
});
