import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', async () => (await import('./testHelpers')).dbMock());
vi.mock('../../services/sentry', async () => (await import('./testHelpers')).sentryMock());

import { LOG_PREFIX, reportOnlyDays } from './shared';

describe('reportOnlyDays (#4342 W6.c)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const lines = () => warn.mock.calls.map((c: unknown[]) => String(c[0]));

  it('uses a valid value silently', () => {
    expect(reportOnlyDays('SSO_SESSION_RETENTION_DAYS', '30', 7, 365)).toBe(30);
    expect(warn).not.toHaveBeenCalled();
  });

  it('uses the default silently when the variable is unset or empty', () => {
    expect(reportOnlyDays('SSO_SESSION_RETENTION_DAYS', undefined, 7, 365)).toBe(7);
    expect(reportOnlyDays('SSO_SESSION_RETENTION_DAYS', '', 7, 365)).toBe(7);
    expect(warn).not.toHaveBeenCalled();
  });

  // A typo used to fall back to the default with no trace, so the nightly
  // count was read as the operator's window when it was not.
  it.each(['0', '-5', 'ninety', 'NaN'])('warns once, naming the variable and the default it uses, for %j', (raw) => {
    expect(reportOnlyDays('SSO_SESSION_RETENTION_DAYS', raw, 7, 365)).toBe(7);
    expect(warn).toHaveBeenCalledTimes(1);
    const [line] = lines();
    expect(line).toContain(LOG_PREFIX);
    expect(line).toContain('SSO_SESSION_RETENTION_DAYS');
    expect(line).toContain(`"${raw}"`);
    expect(line).toContain('7 days');
    expect(line).toContain('nothing is deleted');
  });

  it('caps a long raw value in the warning', () => {
    const raw = `x${'y'.repeat(5000)}`;
    expect(reportOnlyDays('SSO_SESSION_RETENTION_DAYS', raw, 7, 365)).toBe(7);
    expect(warn).toHaveBeenCalledTimes(1);
    const [line] = lines();
    expect(line).toContain('SSO_SESSION_RETENTION_DAYS');
    expect(line).not.toContain(raw);
    expect(line!.length).toBeLessThan(300);
  });

  it('still warns once when a value above the cap is clamped', () => {
    expect(reportOnlyDays('SSO_SESSION_RETENTION_DAYS', '9999', 7, 365)).toBe(365);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(lines()[0]).toContain('exceeds the 365-day cap');
  });
});
