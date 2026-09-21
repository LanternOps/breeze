import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const harness = vi.hoisted(() => ({ manageBilling: false, cursor: 0, update: vi.fn() }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useEffect: () => {},
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    const value = index === 0 ? '2026-09-14' : index === 1 ? {
      week: '2026-09-14', entries: [{
        id: 'e1', ticketId: null, startedAt: '2026-09-15T10:00:00Z', endedAt: '2026-09-15T10:30:00Z',
        durationMinutes: 30, description: 'Work', isBillable: true, billingStatus: 'not_billed', isApproved: false,
      }],
    } : index === 3 ? false : initial;
    return [value, vi.fn()];
  },
}));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator', KeyboardAvoidingView: 'KeyboardAvoidingView', Platform: {},
  Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('@react-navigation/native', () => ({ useFocusEffect: () => {} }));
vi.mock('../../store', () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: (select: (state: unknown) => unknown) => select({
    time: { denial: null }, tickets: { tickets: [] }, timeSuggestions: { enabled: false, unloggedCount: 0 },
  }),
}));
vi.mock('../../lib/useTimeEntryBillingPermission', () => ({ useTimeEntryBillingPermission: () => harness.manageBilling }));
vi.mock('../../services/timeEntries', () => ({ getTimesheet: vi.fn(), updateTimeEntry: harness.update }));
vi.mock('../../services/timeSuggestions', () => ({ getSuggestions: vi.fn() }));
vi.mock('../../components/toast/ToastHost', () => ({ useToast: () => ({ show: vi.fn() }) }));
vi.mock('../../lib/errorReporting', () => ({ reportInternalError: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));
import { TimesheetScreen } from './TimesheetScreen';

type Element = ReactElement<Record<string, any>>;
function nodes(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const node = tree as Element;
  return [node, ...nodes(node.props.children)];
}
beforeEach(() => { vi.clearAllMocks(); harness.cursor = 0; harness.manageBilling = false; });
describe('TimesheetScreen billing actions', () => {
  it('keeps description editing but hides billing changes without manage_billing', () => {
    const tree = nodes(TimesheetScreen());
    expect(tree.some(node => node.props.accessibilityLabel === 'Edit description')).toBe(true);
    expect(tree.some(node => node.props.accessibilityLabel === 'Mark non-billable')).toBe(false);
  });
  it('offers the billing chip with manage_billing', () => {
    harness.manageBilling = true;
    expect(nodes(TimesheetScreen()).some(node => node.props.accessibilityLabel === 'Mark non-billable')).toBe(true);
  });
});
