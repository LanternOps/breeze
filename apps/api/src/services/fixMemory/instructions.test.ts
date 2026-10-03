import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ values: vi.fn(), rows: [] as unknown[][] }));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'update', 'set', 'returning']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(h.rows.shift() ?? []).then(r);
  (chain as { insert: unknown }).insert = vi.fn(() => ({ values: (v: unknown) => { h.values(v); return { returning: async () => [{ id: 'fi-1', ...(v as object) }] }; } }));
  return { db: chain };
});

import { builtinParamsFromSignature, loadActiveInstructions, retireReviewedInstructions, saveReviewedInstructions } from './instructions';

describe('reviewed instructions', () => {
  it('saves exactly the human-submitted text, trimmed, with the reviewer', async () => {
    await saveReviewedInstructions({ partnerId: 'p-1', reviewedBy: 'u-1', title: ' Clear print queue ', steps: [' Stop Spooler', 'Delete queue files '], osType: 'windows' });
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({
      partnerId: 'p-1', reviewedBy: 'u-1', title: 'Clear print queue', steps: ['Stop Spooler', 'Delete queue files'], osType: 'windows',
    }));
  });

  it('refuses empty or oversized steps', async () => {
    await expect(saveReviewedInstructions({ partnerId: 'p-1', reviewedBy: 'u-1', title: 't', steps: [], osType: null })).rejects.toThrow();
    await expect(saveReviewedInstructions({ partnerId: 'p-1', reviewedBy: 'u-1', title: 't', steps: Array(13).fill('a'), osType: null })).rejects.toThrow();
  });

  it('retire reports whether a row was retired; load returns null when none visible', async () => {
    h.rows.push([{ id: 'fi-1' }]);
    expect(await retireReviewedInstructions({ id: 'fi-1', partnerId: 'p-1' })).toBe(true);
    h.rows.push([]);
    expect(await retireReviewedInstructions({ id: 'fi-1', partnerId: 'p-1' })).toBe(false);
    h.rows.push([]);
    expect(await loadActiveInstructions('fi-1')).toBeNull();
  });
});

describe('built-in params from the signature discriminator', () => {
  it.each([
    ['restart_service', { kind: 'service', value: 'spooler' }, { serviceName: 'spooler' }],
    ['kill_process', { kind: 'process', value: 'spoolsv.exe' }, { processName: 'spoolsv.exe' }],
    ['reboot', null, {}],
    ['restart_service', { kind: 'process', value: 'x' }, null],
    ['restart_service', null, null],
    ['disk_cleanup', null, null],
  ])('%s + %o → %o', (action, disc, expected) => {
    expect(builtinParamsFromSignature(action as never, disc as never)).toEqual(expected);
  });
});
