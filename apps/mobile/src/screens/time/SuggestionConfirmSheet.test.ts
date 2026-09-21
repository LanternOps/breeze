import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const harness = vi.hoisted(() => ({
  states: [] as unknown[], cursor: 0, manageBilling: false,
  dispatch: vi.fn(), confirm: vi.fn(), enqueue: vi.fn(),
}));
// Exercise the shipped component's handlers without loading the native runtime.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useCallback: (fn: unknown) => fn,
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.states)) harness.states[index] = initial;
    return [harness.states[index], (value: unknown) => { harness.states[index] = value; }];
  },
}));
vi.mock('react-native', () => ({
  Modal: 'Modal', Pressable: 'Pressable', Switch: 'Switch', Text: 'Text', TextInput: 'TextInput', View: 'View',
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../../store', () => ({ useAppDispatch: () => harness.dispatch }));
vi.mock('../../lib/useTimeEntryBillingPermission', () => ({ useTimeEntryBillingPermission: () => harness.manageBilling }));
vi.mock('../../services/timeSuggestions', () => ({ confirmSuggestion: harness.confirm }));
vi.mock('../../services/timeEntryQueue', () => ({ enqueue: harness.enqueue }));
vi.mock('../../lib/errorReporting', () => ({ reportInternalError: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));
import { SuggestionConfirmSheet } from './SuggestionConfirmSheet';
import type { TimeSuggestion } from '../../services/timeSuggestions';

const suggestion: TimeSuggestion = {
  key: 'session', signals: [{ kind: 'remote_session', id: 's1', type: 'desktop', startedAt: '2026-09-19T10:00:00Z', endedAt: '2026-09-19T10:30:00Z', precision: 'exact' }],
  startedAt: '2026-09-19T10:00:00Z', endedAt: '2026-09-19T10:30:00Z', durationMinutes: 30,
  candidateTicket: null, device: null, org: null, quickSupport: null, otherTickets: [], suggestedSource: 'remote_session', alreadyLoggedOverlapMinutes: 0,
};
type Element = ReactElement<Record<string, any>>;
function nodes(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const node = tree as Element;
  return [node, ...nodes(node.props.children)];
}
const onLogged = vi.fn();
function render() {
  harness.cursor = 0;
  return nodes(SuggestionConfirmSheet({ suggestion, timeZone: 'UTC', onClose: vi.fn(), onLogged }));
}
async function submit() {
  render().find(node => node.type === 'Pressable' && 'disabled' in node.props)!.props.onPress();
  await new Promise(resolve => setTimeout(resolve, 0));
}
beforeEach(() => {
  vi.clearAllMocks(); harness.states = []; harness.manageBilling = false;
  harness.confirm.mockResolvedValue({}); harness.enqueue.mockResolvedValue({});
});
describe('SuggestionConfirmSheet billing overrides', () => {
  it('hides the switch and omits isBillable without manage_billing', async () => {
    expect(render().filter(node => node.type === 'Switch')).toHaveLength(0);
    await submit();
    expect(harness.confirm.mock.calls[0]![0]).not.toHaveProperty('isBillable');
  });
  it('omits the unchanged default even with manage_billing', async () => {
    harness.manageBilling = true;
    await submit();
    expect(harness.confirm.mock.calls[0]![0]).not.toHaveProperty('isBillable');
  });
  it('sends an explicit override only after an authorized user changes it', async () => {
    harness.manageBilling = true;
    render().find(node => node.type === 'Switch')!.props.onValueChange(false);
    await submit();
    expect(harness.confirm.mock.calls[0]![0]).toHaveProperty('isBillable', false);
  });
  it('queues an omitted override unchanged when offline', async () => {
    harness.confirm.mockRejectedValue(new Error('Offline'));
    await submit();
    expect(harness.enqueue.mock.calls[0]![0].payload).not.toHaveProperty('isBillable');
  });
  it('shows a billing denial on the sheet without disabling suggestions', async () => {
    harness.confirm.mockRejectedValue(Object.assign(new Error('Billing permission required'), { status: 403, code: 'MANAGE_BILLING_REQUIRED' }));
    await submit();
    expect(harness.dispatch.mock.calls.flat().some(action => action.type === 'timeSuggestions/suggestionsDisabled')).toBe(false);
    expect(render().some(node => node.props.children === 'Billing permission required')).toBe(true);
    expect(onLogged).not.toHaveBeenCalled();
  });
});
