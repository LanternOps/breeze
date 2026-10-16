import { describe, it, expect } from 'vitest';
import { shouldRefreshAlerts } from './homeAlertsRefresh';

// #8890: the header StatusPill reads the alerts slice, which only refetched on
// Home focus — alerts resolved through chat (no focus change) left it stale
// while the fleet strip (own fetch) already said "no issues".
describe('shouldRefreshAlerts', () => {
  it('refreshes when a chat turn finishes, even right after a focus fetch', () => {
    expect(shouldRefreshAlerts('turn_done', 100)).toBe(true);
  });
  it('refreshes on focus and on foreground', () => {
    expect(shouldRefreshAlerts('focus', 60_000)).toBe(true);
    expect(shouldRefreshAlerts('foreground', 60_000)).toBe(true);
  });
  it('collapses duplicate triggers inside the min gap', () => {
    expect(shouldRefreshAlerts('focus', 100)).toBe(false);
    expect(shouldRefreshAlerts('foreground', 100)).toBe(false);
  });
  it('refreshes when nothing has been fetched yet', () => {
    expect(shouldRefreshAlerts('focus', Infinity)).toBe(true);
  });
});
