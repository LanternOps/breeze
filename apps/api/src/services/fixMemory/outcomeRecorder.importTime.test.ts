import { describe, expect, it, vi } from 'vitest';

// #7281: the summary column map must not be built from the schema at import
// time (same trap fixed in store.ts) — a partial schema mock, or a circular
// import, would capture `undefined` columns for the life of the process.
const h = vi.hoisted(() => ({ reads: [] as string[] }));

vi.mock('../../db', () => ({ db: {}, withDbTransaction: (fn: () => unknown) => fn() }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../db/schema', () => ({
  fixOutcomes: new Proxy({}, { get: (_t, prop) => { h.reads.push(String(prop)); return undefined; } }),
  organizations: {},
  remediationSuggestions: {},
  scriptExecutions: {},
  scripts: {},
}));

describe('outcomeRecorder module load', () => {
  it('does not read fixOutcomes columns while importing', async () => {
    await import('./outcomeRecorder');
    expect(h.reads).toEqual([]);
  });
});
