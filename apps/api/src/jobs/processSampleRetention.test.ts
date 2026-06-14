import { describe, it, expect, vi } from 'vitest';

// Avoid real Redis/DB/Sentry side effects when importing the module under test.
vi.mock('../db', () => ({ db: {}, withSystemDbAccessContext: (fn: any) => fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: () => {} }));

import { extractRowCount } from './processSampleRetention';

describe('extractRowCount (batched-delete loop termination depends on this)', () => {
  it('prefers rowCount (node-postgres) over count', () => {
    expect(extractRowCount({ rowCount: 7, count: 3 })).toBe(7);
  });

  it('falls back to count (postgres-js DELETE result)', () => {
    expect(extractRowCount({ count: 5 })).toBe(5);
  });

  it('falls back to array length when the driver returns rows', () => {
    expect(extractRowCount([{}, {}, {}])).toBe(3);
  });

  it('returns 0 for an unrecognized object shape (does not falsely terminate as a partial batch)', () => {
    expect(extractRowCount({})).toBe(0);
  });

  it('reports a full batch as the batch size so the loop continues', () => {
    // A full batch (count === BATCH_SIZE) must not be read as < BATCH_SIZE.
    expect(extractRowCount({ count: 10000 })).toBe(10000);
  });
});
