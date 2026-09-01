import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {}, withSystemDbAccessContext: (fn: () => unknown) => fn(), runOutsideDbContext: (fn: () => unknown) => fn() }));
vi.mock('./effectiveSettings', () => ({ getEffectiveAiBudget: vi.fn(), DEFAULT_AI_ALERT_THRESHOLD_PERCENTS: [50, 80, 95] }));
vi.mock('./llm/llmConfigResolver', () => ({ getLlmBillingSourceForOrg: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { normalizeAlertThresholds } from './aiBudgetAlerts';

describe('normalizeAlertThresholds', () => {
  it('sorts and dedupes', () => {
    expect(normalizeAlertThresholds([95, 50, 80, 50])).toEqual([50, 80, 95]);
  });
  it('accepts an empty ladder', () => {
    expect(normalizeAlertThresholds([])).toEqual([]);
  });
  it.each([[0], [100], [50.5], [-1]])('rejects %s', (bad) => {
    expect(() => normalizeAlertThresholds([bad])).toThrow(RangeError);
  });
});
