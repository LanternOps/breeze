import { describe, it, expect } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { DatasetRequest } from '../aiToolsExportDatasets';
import { EXPORT_DATASETS } from '../aiToolsExportDatasetNames';
import { withRequestedDevicesAsFrame } from './legacyFrame';

function req(over: Partial<DatasetRequest> = {}): DatasetRequest {
  return {
    auth: { orgId: 'org-1' } as unknown as AuthContext,
    orgId: 'org-1',
    filters: {},
    deviceIds: null,
    runTargets: null,
    siteId: null,
    pageSize: 500,
    notes: [],
    exportGrants: { datasets: [...EXPORT_DATASETS], sensitiveGates: [] },
    ...over,
  };
}

describe('withRequestedDevicesAsFrame', () => {
  it('no frame (null) and listed devices: the list becomes the frame, as a copy', () => {
    const ids = ['a', 'b'];
    const r = req({ deviceIds: ids });
    const out = withRequestedDevicesAsFrame(r);
    expect(out.runTargets).toEqual(['a', 'b']);
    expect(out.runTargets).not.toBe(ids);
    expect(out.deviceIds).toBe(ids);
    // the original is not mutated
    expect(r.runTargets).toBeNull();
  });

  it('an empty frame counts as no frame', () => {
    expect(withRequestedDevicesAsFrame(req({ runTargets: [], deviceIds: ['a'] })).runTargets).toEqual(['a']);
  });

  it('keeps the same notes array so resolver notes reach the result', () => {
    const r = req({ deviceIds: ['a'] });
    expect(withRequestedDevicesAsFrame(r).notes).toBe(r.notes);
  });

  it('an existing frame is returned untouched (same object)', () => {
    const r = req({ runTargets: ['f1'], deviceIds: ['a'] });
    expect(withRequestedDevicesAsFrame(r)).toBe(r);
    expect(r.runTargets).toEqual(['f1']);
  });

  it('neither frame nor list: returned untouched, still no frame', () => {
    const r = req();
    expect(withRequestedDevicesAsFrame(r)).toBe(r);
    expect(withRequestedDevicesAsFrame(req({ deviceIds: [] })).runTargets).toBeNull();
  });
});
