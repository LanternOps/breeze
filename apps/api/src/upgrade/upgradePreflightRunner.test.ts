import { describe, expect, it, vi } from 'vitest';

// A database that accepts the connection and never answers: every query stays
// pending. The preflight's own timeout is the only way out.
const end = vi.fn(async () => {});
vi.mock('postgres', () => {
  const never = () => new Promise(() => {});
  const sql = Object.assign(vi.fn(never), { unsafe: vi.fn(never), end });
  return { default: vi.fn(() => sql) };
});

const { runUpgradePreflight } = await import('./upgradePreflightRunner');

describe('runUpgradePreflight against a database that never answers', () => {
  it('times out into the broad report and closes the connection', async () => {
    const logger = { log: vi.fn(), warn: vi.fn() };
    const started = Date.now();
    const { report, exitCode } = await runUpgradePreflight({
      databaseUrl: 'postgresql://wedged',
      currentVersion: '0.116.0',
      logger,
      timeoutMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(report.historyKnown).toBe(false);
    expect(report.historyNote).toMatch(/did not answer within 50ms/);
    expect(report.crossing.map((c) => c.certainty)).toContain('possible');
    expect(exitCode).toBe(0);
    expect(end).toHaveBeenCalled();
    expect(String(logger.warn.mock.calls[0]?.[0])).toMatch(/no version history/i);
  });
});
