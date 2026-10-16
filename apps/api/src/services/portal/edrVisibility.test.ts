import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] as unknown[], selects: 0 }));
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      state.selects += 1;
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'where']) chain[m] = vi.fn(() => chain);
      chain.limit = vi.fn(async () => state.rows);
      return chain;
    }),
  },
}));

import { edrReportEvidenceAllowed, isEdrVisibilityEnabled } from './edrVisibility';

describe('portal EDR visibility (#8166)', () => {
  beforeEach(() => { state.rows = []; state.selects = 0; });

  it('isEdrVisibilityEnabled fails closed: missing row or anything but true is off', async () => {
    expect(await isEdrVisibilityEnabled('org-1')).toBe(false);
    state.rows = [{ enabled: false }];
    expect(await isEdrVisibilityEnabled('org-1')).toBe(false);
    state.rows = [{ enabled: true }];
    expect(await isEdrVisibilityEnabled('org-1')).toBe(true);
  });

  it('MSP-side report runs (user / system) may always use EDR evidence, without reading the flag', async () => {
    expect(await edrReportEvidenceAllowed('org-1', { principalKind: 'user' })).toBe(true);
    expect(await edrReportEvidenceAllowed('org-1', { principalKind: 'system' })).toBe(true);
    expect(state.selects).toBe(0);
  });

  it('a portal-user report run honours the strict flag', async () => {
    expect(await edrReportEvidenceAllowed('org-1', { principalKind: 'portal_user' })).toBe(false);
    state.rows = [{ enabled: true }];
    expect(await edrReportEvidenceAllowed('org-1', { principalKind: 'portal_user' })).toBe(true);
  });
});
