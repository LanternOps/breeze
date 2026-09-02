import { describe, it, expect, vi } from 'vitest';
import type { Alert } from '../../../services/api';

// StatusPill.tsx is a screen component (imports react-native, reanimated,
// react-navigation, ...) and this app has no RN test renderer configured for
// vitest (see the "Pure-logic smoke tests only" note in vitest.config.ts —
// component imports are deliberately kept out of it). Every direct import of
// StatusPill.tsx is stubbed here so the module can load far enough to expose
// `selectAlertCounts`, which is what this suite actually exercises.
vi.mock('react-native', () => ({
  Pressable: () => null,
  Text: () => null,
  View: () => null,
}));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock('../../../theme', () => ({
  useApprovalTheme: () => ({}),
  palette: { deny: {}, warning: {}, brand: {} },
  radii: {},
  spacing: {},
  type: {},
}));
vi.mock('../../../lib/motion', () => ({ haptic: { tap: vi.fn() } }));
vi.mock('../../../lib/useNetworkConnected', () => ({ useNetworkConnected: () => true }));
// A trivial stand-in for the real store: selectAlertCounts is built on top of
// `selectAlerts`, and this suite only needs that one selector to behave like
// the real one (read `state.alerts.alerts`) — pulling in the actual redux
// store would drag services/api.ts (expo-secure-store, ...) in with it.
vi.mock('../../../store', () => ({
  useAppSelector: vi.fn(),
  selectAlerts: (state: { alerts: { alerts: unknown[] } }) => state.alerts.alerts,
}));

const { selectAlertCounts } = await import('./StatusPill');

// TypeScript checks this file against the REAL `selectAlerts` / `Alert`
// types (vi.mock only swaps the runtime module, not its type), so the
// fixtures below carry the full `Alert` and `AlertsState` shapes even though
// selectAlertCounts only ever reads `acknowledged` and `severity`.
function alert(over: Partial<Alert> & Pick<Alert, 'acknowledged' | 'severity'>, id: string): Alert {
  return {
    id,
    title: 'Alert',
    message: 'Alert',
    type: 'alert',
    createdAt: '2026-08-18T00:00:00Z',
    updatedAt: '2026-08-18T00:00:00Z',
    ...over,
  };
}

function stateWith(alerts: Alert[]) {
  return {
    alerts: { alerts, isLoading: false, error: null, filter: 'all' as const, lastFetched: null },
  };
}

describe('selectAlertCounts', () => {
  it('counts unacknowledged critical and (high | medium) severities, skipping acknowledged and low', () => {
    const alerts: Alert[] = [
      alert({ acknowledged: false, severity: 'critical' }, '1'),
      alert({ acknowledged: false, severity: 'critical' }, '2'),
      alert({ acknowledged: true, severity: 'critical' }, '3'), // acknowledged -> skipped
      alert({ acknowledged: false, severity: 'high' }, '4'),
      alert({ acknowledged: false, severity: 'medium' }, '5'),
      alert({ acknowledged: false, severity: 'low' }, '6'), // low -> not counted at all
      alert({ acknowledged: true, severity: 'high' }, '7'), // acknowledged -> skipped
    ];

    expect(selectAlertCounts(stateWith(alerts))).toEqual({ critical: 2, warning: 2 });
  });

  it('returns the SAME object reference across calls when the alerts array reference is unchanged', () => {
    // This is the regression case for the "Selector ... returned a different
    // result" warning: the inline selector StatusPill used to pass allocated
    // a brand-new { critical, warning } object on every call, so useSelector
    // saw a new reference (and re-rendered) even when nothing relevant
    // changed. A real dispatch replaces the root state object on every
    // action, so the fix has to be robust to a NEW outer `state` wrapping
    // the SAME `alerts.alerts` array — which is exactly what happens when an
    // unrelated slice (tickets, auth, timer ticks, ...) updates.
    const alerts: Alert[] = [alert({ acknowledged: false, severity: 'critical' }, '1')];
    const state1 = stateWith(alerts);
    const state2 = stateWith(alerts); // new outer object, same inner array reference

    const result1 = selectAlertCounts(state1);
    const result2 = selectAlertCounts(state2);

    expect(result2).toBe(result1);
  });

  it('recomputes (a new reference) once the alerts array reference actually changes', () => {
    const alerts1: Alert[] = [alert({ acknowledged: false, severity: 'critical' }, '1')];
    const alerts2: Alert[] = [alert({ acknowledged: false, severity: 'critical' }, '1')];

    const result1 = selectAlertCounts(stateWith(alerts1));
    const result2 = selectAlertCounts(stateWith(alerts2));

    expect(result2).toEqual(result1);
    expect(result2).not.toBe(result1);
  });
});
