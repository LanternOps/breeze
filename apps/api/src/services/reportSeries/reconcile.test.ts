import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({
  execute: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock('../../db', () => ({
  db: dbMock,
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../sentry', () => sentry);

import { reconcileAllSeries, seriesChildConfig } from './reconcile';
import { emptyReconcileResult } from './types';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

// Review Focus 5.
describe('reconcileAllSeries', () => {
  it('isolates a failing series: the rest still reconcile and the sweep resolves', async () => {
    dbMock.execute.mockResolvedValue([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
    const reconcileOne = vi.fn(async (id: string) => {
      if (id === 's2') throw new Error('boom');
      return emptyReconcileResult();
    });
    await expect(reconcileAllSeries({ reconcileOne })).resolves.toBeUndefined();
    expect(reconcileOne.mock.calls.map((call) => call[0])).toEqual(['s1', 's2', 's3']);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('is bounded: processes at most `limit` series and warns about the remainder', async () => {
    dbMock.execute.mockResolvedValue([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
    const reconcileOne = vi.fn(async () => emptyReconcileResult());
    await reconcileAllSeries({ limit: 2, reconcileOne });
    expect(reconcileOne).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('repair sweep backlog'),
      expect.objectContaining({ limit: 2 }),
    );
  });
});

describe('seriesChildConfig', () => {
  it('replaces any emailRecipients with the series internal CC', () => {
    expect(seriesChildConfig({ columns: ['a'], emailRecipients: ['old@x.test'] }, ['noc@msp.test']))
      .toEqual({ columns: ['a'], emailRecipients: ['noc@msp.test'] });
  });
  it('omits emailRecipients entirely when there is no internal CC', () => {
    expect(seriesChildConfig({ columns: ['a'], emailRecipients: ['old@x.test'] }, [])).toEqual({ columns: ['a'] });
  });
  it('treats a non-object config as empty', () => {
    expect(seriesChildConfig(null, [])).toEqual({});
  });
});
