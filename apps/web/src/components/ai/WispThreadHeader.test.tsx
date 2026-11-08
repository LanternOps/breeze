import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WispState } from '@/stores/aiStore';

const h = vi.hoisted(() => ({
  runAction: vi.fn(),
  fetchWithAuth: vi.fn(),
  exitWispMode: vi.fn(),
  setWispFocus: vi.fn(),
  updateWisp: vi.fn(),
  closeSession: vi.fn(),
  enterWispMode: vi.fn(),
  chat: { sessionId: null as string | null, wisp: null as null | { grantId: string } } as {
    sessionId: string | null; wisp: null | { grantId: string }; error?: string | null; errorCode?: string | null;
  },
  limits: { maxGrants: 25, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 20 } as unknown,
  modalProps: null as null | Record<string, unknown>,
  orgs: [
    { id: 'org-a', name: 'Alpha', status: 'active' },
    { id: 'org-b', name: 'Bravo', status: 'active' },
  ],
}));
vi.mock('@/lib/runAction', () => ({
  runAction: (o: unknown) => h.runAction(o),
  ActionError: class ActionError extends Error { status = 0; },
}));
vi.mock('@/stores/auth', () => ({
  fetchWithAuth: h.fetchWithAuth,
  useAuthStore: (sel: (s: { isAuthenticated: boolean }) => unknown) => sel({ isAuthenticated: true }),
}));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/hooks/useEntitlement', () => ({ useEntitlement: () => ({ state: 'enabled', limits: h.limits }) }));
vi.mock('@/stores/orgStore', () => ({ useOrgStore: (sel: (s: unknown) => unknown) => sel({ organizations: h.orgs }) }));
vi.mock('@/stores/aiStore', () => ({
  useAiStore: (sel: (s: unknown) => unknown) =>
    sel({
      exitWispMode: h.exitWispMode, setWispFocus: h.setWispFocus, updateWisp: h.updateWisp,
      closeSession: h.closeSession, enterWispMode: h.enterWispMode, ...h.chat,
    }),
}));
vi.mock('./WispGrantStepUpModal', () => ({
  default: (props: Record<string, unknown>) => {
    h.modalProps = props;
    return props.open ? <div data-testid="wisp-refresh-modal-mock" /> : null;
  },
}));

import WispThreadHeader, { WispGrantActions, WispGrantDetails } from './WispThreadHeader';
import { useWispGrantControls } from './useWispGrantControls';

type Wisp = NonNullable<WispState>;

/**
 * The rail's layout of the grant controls (WispRail): the actions end the
 * identity card's title row, the details sit under it, one shared hook.
 */
function Rail({ wisp: w, orgName = null, wideningAvailable, onWispChange, onRevoked }: {
  wisp: Wisp;
  orgName?: string | null;
  wideningAvailable: boolean;
  onWispChange?: (patch: Partial<Wisp>) => void;
  onRevoked?: () => void | Promise<void>;
}) {
  const controls = useWispGrantControls({ wisp: w, orgName, onWispChange, onRevoked });
  return (
    <>
      <div data-testid="actions-slot"><WispGrantActions controls={controls} wideningAvailable={wideningAvailable} /></div>
      <WispGrantDetails wisp={w} wideningAvailable={wideningAvailable} controls={controls} />
    </>
  );
}

function wisp(overrides: Partial<NonNullable<WispState>> = {}): NonNullable<WispState> {
  return {
    grantId: 'g-1', threadId: 't-1', scopeOrgId: null, focusOrgId: null, focusOrgName: null, status: 'active',
    expiresAt: '2027-01-01T00:00:00.000Z', summary: '', budgetCentsPerDay: 200, floorTickMinutes: 30, wideningAvailable: false,
    ...overrides,
  };
}

// The grant controls (W04 Task 8) as the rail lays them out, plus the pane
// header's scope, status dot and focus select.
describe('Wisp grant controls (W04 Task 8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.modalProps = null;
    h.chat = { sessionId: null, wisp: null };
    h.limits = { maxGrants: 25, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 20 };
    h.runAction.mockImplementation(async (o: { request: () => Promise<Response> }) => {
      const r = await o.request();
      return r.json();
    });
    h.fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
  });

  it('the pane header shows "All organizations" for a partner-wide grant and the org name for an org grant', () => {
    const { rerender } = render(<WispThreadHeader wisp={wisp()} orgName={null} wideningAvailable={false} />);
    expect(screen.getByTestId('wisp-scope').textContent).toBe('All organizations');
    rerender(<WispThreadHeader wisp={wisp({ scopeOrgId: 'org-a' })} orgName="Alpha" wideningAvailable={false} />);
    expect(screen.getByTestId('wisp-scope').textContent).toBe('Alpha');
  });

  // The Wisp rail places the parts itself: the actions in its identity card's
  // title row (which already states scope and status), the details under it.
  it('the rail\'s parts: the details carry no scope, status or action buttons (no icon-only row); the actions drive the shared controls', () => {
    function RailParts() {
      const controls = useWispGrantControls({ wisp: wisp(), orgName: null });
      return (
        <>
          <div data-testid="actions-slot"><WispGrantActions controls={controls} wideningAvailable={false} /></div>
          <WispGrantDetails wisp={wisp({ spentTodayCents: 50, budgetResetsAt: '2027-01-01T00:00:00.000Z' })} wideningAvailable={false} controls={controls} />
        </>
      );
    }
    render(<RailParts />);
    const details = screen.getByTestId('wisp-grant-details');
    for (const id of ['wisp-scope', 'wisp-grant-status', 'wisp-refresh-grant', 'wisp-settings', 'wisp-revoke', 'wisp-focus']) {
      expect(within(details).queryByTestId(id)).toBeNull();
    }
    const actions = screen.getByTestId('actions-slot');
    for (const id of ['wisp-refresh-grant', 'wisp-settings', 'wisp-revoke']) expect(within(actions).getByTestId(id)).toBeInTheDocument();
    // Settings toggled from the title row opens the panel in the details.
    expect(within(details).queryByTestId('wisp-settings-budget')).toBeNull();
    fireEvent.click(within(actions).getByTestId('wisp-settings'));
    expect(within(actions).getByTestId('wisp-settings')).toHaveAttribute('aria-expanded', 'true');
    expect(within(details).getByTestId('wisp-settings-budget')).toBeInTheDocument();
  });

  it.each([
    ['active', 'Active'],
    ['paused', 'Paused'],
    ['revoked', 'Revoked'],
    ['expired', 'Expired'],
  ] as const)('the pane header names the %s status on its dot', (status, text) => {
    render(<WispThreadHeader wisp={wisp({ status })} orgName={null} wideningAvailable={false} />);
    expect(screen.getByTestId('wisp-grant-status')).toHaveAttribute('aria-label', text);
  });

  it('revoke asks for confirmation, posts /wisp/grants/:id/revoke through runAction and exits Wisp mode', async () => {
    render(<Rail wisp={wisp()} orgName={null} wideningAvailable={false} />);
    fireEvent.click(screen.getByTestId('wisp-revoke'));
    expect(h.runAction).not.toHaveBeenCalled();
    expect(screen.getByText('Turn off Wisp for this scope? Wisp stops working for you and its threads close. Their conversations, concerns and activity are no longer shown.')).toBeInTheDocument();
    // #10104: turning off revokes the grant, and an ended grant reads nothing.
    expect(screen.queryByText(/stay readable/i)).toBeNull();
    fireEvent.click(screen.getByTestId('wisp-revoke-confirm'));
    await waitFor(() => expect(h.exitWispMode).toHaveBeenCalledTimes(1));
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/grants/g-1/revoke', { method: 'POST' });
    expect(h.runAction).toHaveBeenCalledWith(expect.objectContaining({ successMessage: 'Wisp is off', errorFallback: 'Could not turn off Wisp' }));
  });

  it('a refused revoke keeps Wisp mode on', async () => {
    h.runAction.mockRejectedValueOnce(new Error('boom'));
    render(<Rail wisp={wisp()} orgName={null} wideningAvailable={false} />);
    fireEvent.click(screen.getByTestId('wisp-revoke'));
    fireEvent.click(screen.getByTestId('wisp-revoke-confirm'));
    await waitFor(() => expect(h.runAction).toHaveBeenCalled());
    expect(h.exitWispMode).not.toHaveBeenCalled();
  });

  it('refresh button is primary with the widening line when wideningAvailable and secondary without it otherwise', () => {
    const { rerender } = render(<Rail wisp={wisp()} orgName={null} wideningAvailable />);
    expect(screen.getByTestId('wisp-refresh-grant')).toHaveAttribute('data-variant', 'primary');
    expect(screen.getByTestId('wisp-widening')).toBeInTheDocument();
    rerender(<Rail wisp={wisp()} orgName={null} wideningAvailable={false} />);
    expect(screen.getByTestId('wisp-refresh-grant')).toHaveAttribute('data-variant', 'secondary');
    expect(screen.queryByTestId('wisp-widening')).toBeNull();
  });

  it('refresh opens the step-up modal for this grant and merges the refreshed grant into the store', async () => {
    render(<Rail wisp={wisp({ scopeOrgId: 'org-a' })} orgName="Alpha" wideningAvailable />);
    fireEvent.click(screen.getByTestId('wisp-refresh-grant'));
    expect(screen.getByTestId('wisp-refresh-modal-mock')).toBeInTheDocument();
    expect(h.modalProps?.refresh).toEqual({ grantId: 'g-1', orgId: 'org-a' });
    const fresh = wisp({ scopeOrgId: 'org-a', expiresAt: '2027-04-01T00:00:00.000Z', wideningAvailable: false });
    await act(async () => { (h.modalProps!.onGranted as (w: unknown) => void)(fresh); });
    expect(h.updateWisp).toHaveBeenCalledWith(fresh);
    expect(screen.queryByTestId('wisp-refresh-modal-mock')).toBeNull();
  });

  it('settings popover PATCHes /wisp/grants/:id/settings through runAction with only the changed keys and clamps inputs to the entitlement limits', async () => {
    h.fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'g-1', budgetCentsPerDay: 1000, floorTickMinutes: 30 }) });
    render(<Rail wisp={wisp()} orgName={null} wideningAvailable={false} />);
    fireEvent.click(screen.getByTestId('wisp-settings'));
    const budget = screen.getByTestId('wisp-settings-budget') as HTMLInputElement;
    const tick = screen.getByTestId('wisp-settings-tick') as HTMLInputElement;
    expect(budget.max).toBe('10.00');
    expect(tick.min).toBe('20');
    expect(tick.max).toBe('240');
    fireEvent.change(budget, { target: { value: '50.00' } });
    fireEvent.click(screen.getByTestId('wisp-settings-save'));
    await waitFor(() => expect(h.updateWisp).toHaveBeenCalled());
    const [url, init] = h.fetchWithAuth.mock.calls.find(([u]) => u === '/wisp/grants/g-1/settings')!;
    expect(url).toBe('/wisp/grants/g-1/settings');
    expect(init).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ budgetCentsPerDay: 1000 });
    expect(h.updateWisp).toHaveBeenCalledWith({ budgetCentsPerDay: 1000, floorTickMinutes: 30 });
  });

  it('the budget input shows dollars with two decimals and submits cents', async () => {
    h.fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'g-1', budgetCentsPerDay: 250, floorTickMinutes: 30 }) });
    render(<Rail wisp={wisp()} orgName={null} wideningAvailable={false} />);
    fireEvent.click(screen.getByTestId('wisp-settings'));
    const budget = screen.getByTestId('wisp-settings-budget') as HTMLInputElement;
    expect(budget.value).toBe('2.00');
    fireEvent.change(budget, { target: { value: '2.50' } });
    fireEvent.click(screen.getByTestId('wisp-settings-save'));
    await waitFor(() => expect(h.updateWisp).toHaveBeenCalled());
    const [, init] = h.fetchWithAuth.mock.calls.find(([u]) => u === '/wisp/grants/g-1/settings')!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ budgetCentsPerDay: 250 });
  });

  it('rounds typed dollars to whole cents (0.29 is 29, not 28.999…)', async () => {
    h.fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'g-1', budgetCentsPerDay: 29, floorTickMinutes: 30 }) });
    render(<Rail wisp={wisp()} orgName={null} wideningAvailable={false} />);
    fireEvent.click(screen.getByTestId('wisp-settings'));
    fireEvent.change(screen.getByTestId('wisp-settings-budget'), { target: { value: '0.29' } });
    fireEvent.click(screen.getByTestId('wisp-settings-save'));
    await waitFor(() => expect(h.updateWisp).toHaveBeenCalled());
    const [, init] = h.fetchWithAuth.mock.calls.find(([u]) => u === '/wisp/grants/g-1/settings')!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ budgetCentsPerDay: 29 });
  });

  it('an unchanged dollars field sends no budget patch', async () => {
    render(<Rail wisp={wisp()} orgName={null} wideningAvailable={false} />);
    fireEvent.click(screen.getByTestId('wisp-settings'));
    fireEvent.click(screen.getByTestId('wisp-settings-save'));
    await waitFor(() => expect(screen.queryByTestId('wisp-settings-panel')).toBeNull());
    expect(h.fetchWithAuth.mock.calls.find(([u]) => u === '/wisp/grants/g-1/settings')).toBeUndefined();
  });

  it('settings tick below the plan minimum is raised to it', async () => {
    h.fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'g-1', budgetCentsPerDay: 200, floorTickMinutes: 20 }) });
    render(<Rail wisp={wisp()} orgName={null} wideningAvailable={false} />);
    fireEvent.click(screen.getByTestId('wisp-settings'));
    fireEvent.change(screen.getByTestId('wisp-settings-tick'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('wisp-settings-save'));
    await waitFor(() => expect(h.runAction).toHaveBeenCalled());
    const [, init] = h.fetchWithAuth.mock.calls.find(([u]) => u === '/wisp/grants/g-1/settings')!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ floorTickMinutes: 20 });
  });

  it('focus switcher shows "No customer focus" when focusOrgId is null, the org name when set, and calls setWispFocus(orgId, name) on change', () => {
    const { rerender } = render(<WispThreadHeader wisp={wisp()} orgName={null} wideningAvailable={false} />);
    const select = screen.getByTestId('wisp-focus') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.selectedOptions[0]!.textContent).toBe('No customer focus');
    fireEvent.change(select, { target: { value: 'org-b' } });
    expect(h.setWispFocus).toHaveBeenCalledWith('org-b', 'Bravo');

    rerender(<WispThreadHeader wisp={wisp({ focusOrgId: 'org-a', focusOrgName: 'Alpha' })} orgName={null} wideningAvailable={false} />);
    expect((screen.getByTestId('wisp-focus') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Alpha');
    fireEvent.change(screen.getByTestId('wisp-focus'), { target: { value: '' } });
    expect(h.setWispFocus).toHaveBeenLastCalledWith(null, null);
  });

  it('the focus switcher is disabled while a change is in flight (no racing PATCHes)', async () => {
    let release!: () => void;
    h.setWispFocus.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    render(<WispThreadHeader wisp={wisp()} orgName={null} wideningAvailable={false} />);
    fireEvent.change(screen.getByTestId('wisp-focus'), { target: { value: 'org-a' } });
    expect(screen.getByTestId('wisp-focus')).toBeDisabled();
    await act(async () => { release(); });
    expect(screen.getByTestId('wisp-focus')).toBeEnabled();
  });

  it('an emptied settings field is left unchanged, never saved as 0', async () => {
    h.fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'g-1', budgetCentsPerDay: 200, floorTickMinutes: 60 }) });
    render(<Rail wisp={wisp()} orgName={null} wideningAvailable={false} />);
    fireEvent.click(screen.getByTestId('wisp-settings'));
    fireEvent.change(screen.getByTestId('wisp-settings-budget'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('wisp-settings-tick'), { target: { value: '60' } });
    fireEvent.click(screen.getByTestId('wisp-settings-save'));
    await waitFor(() => expect(h.updateWisp).toHaveBeenCalled());
    const [, init] = h.fetchWithAuth.mock.calls.find(([u]) => u === '/wisp/grants/g-1/settings')!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ floorTickMinutes: 60 });
  });

  it('a refused settings save changes nothing and keeps the popover open', async () => {
    h.runAction.mockRejectedValueOnce(new Error('400 SETTINGS_OUT_OF_BOUNDS'));
    render(<Rail wisp={wisp()} orgName={null} wideningAvailable={false} />);
    fireEvent.click(screen.getByTestId('wisp-settings'));
    fireEvent.change(screen.getByTestId('wisp-settings-budget'), { target: { value: '9.00' } });
    fireEvent.click(screen.getByTestId('wisp-settings-save'));
    await waitFor(() => expect(h.runAction).toHaveBeenCalled());
    expect(h.updateWisp).not.toHaveBeenCalled();
    expect(screen.getByTestId('wisp-settings-panel')).toBeInTheDocument();
  });

  it('an org-scoped grant offers only its own org as a focus', () => {
    render(<WispThreadHeader wisp={wisp({ scopeOrgId: 'org-a' })} orgName="Alpha" wideningAvailable={false} />);
    const values = Array.from((screen.getByTestId('wisp-focus') as HTMLSelectElement).options).map((o) => o.value);
    expect(values).toEqual(['', 'org-a']);
  });
});

describe('Wisp grant controls (W06 T14/T15: caller-owned state, spend meter, pause)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.runAction.mockImplementation(async (o: { request: () => Promise<Response> }) => (await o.request()).json());
    h.fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'g-1', status: 'paused', pausedReason: 'user_paused' }) });
  });

  it('shows the spend meter only when the payload carries both A32 fields', () => {
    const { rerender } = render(<Rail wisp={wisp()} orgName={null} wideningAvailable={false} />);
    expect(screen.queryByTestId('wisp-spend-meter')).toBeNull();
    rerender(
      <Rail wisp={wisp({ spentTodayCents: 42, budgetResetsAt: '2099-01-01T00:00:00.000Z' })} orgName={null} wideningAvailable={false} />,
    );
    expect(screen.getByTestId('wisp-spend-meter').getAttribute('data-state')).toBe('ok');
  });

  it('the exhausted meter opens the budget settings (the notice’s one-tap raise)', () => {
    render(
      <Rail wisp={wisp({ spentTodayCents: 200, budgetResetsAt: '2099-01-01T00:00:00.000Z' })} orgName={null} wideningAvailable={false} />,
    );
    fireEvent.click(screen.getByTestId('wisp-spend-raise'));
    expect(screen.getByTestId('wisp-settings-panel')).toBeTruthy();
  });

  it('an active grant over budget reads "Budget reached", not "Active" (#10145)', () => {
    render(
      <WispThreadHeader wisp={wisp({ spentTodayCents: 201, budgetResetsAt: '2099-01-01T00:00:00.000Z' })} orgName={null} wideningAvailable={false} />,
    );
    expect(screen.getByTestId('wisp-grant-status')).toHaveAttribute('aria-label', 'Budget reached');
  });

  it('under budget the status stays Active (#10145)', () => {
    render(
      <WispThreadHeader wisp={wisp({ spentTodayCents: 50, budgetResetsAt: '2099-01-01T00:00:00.000Z' })} orgName={null} wideningAvailable={false} />,
    );
    expect(screen.getByTestId('wisp-grant-status')).toHaveAttribute('aria-label', 'Active');
  });

  it('budget pause at the plan ceiling: names the pause and offers no raise (#10106)', () => {
    const budgetResetsAt = new Date(Date.now() + 20 * 3600_000 - 60_000).toISOString();
    render(
      <Rail
        wisp={wisp({ status: 'paused', pausedReason: 'budget_exhausted', budgetCentsPerDay: 1000, spentTodayCents: 1000, budgetResetsAt })}
        orgName={null}
        wideningAvailable={false}
      />,
    );
    expect(screen.getByTestId('wisp-paused-system')).toHaveTextContent('20 h');
    expect((screen.getByTestId('wisp-resume') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('wisp-spend-raise')).toBeNull();
    expect(screen.getByTestId('wisp-spend-at-ceiling')).toBeTruthy();
  });

  it('partner-disabled: no Resume and no "Raise today\'s budget", even when over budget (#10145)', () => {
    const w = wisp({ status: 'paused', pausedReason: 'partner_disabled', spentTodayCents: 300, budgetResetsAt: '2099-01-01T00:00:00.000Z' });
    const { unmount } = render(<Rail wisp={w} orgName={null} wideningAvailable={false} />);
    expect(screen.queryByTestId('wisp-resume')).toBeNull();
    expect(screen.queryByTestId('wisp-spend-raise')).toBeNull();
    expect(screen.getByTestId('wisp-spend-meter')).toBeTruthy();
    unmount();
    // a paused grant is Paused, never "Budget reached"
    render(<WispThreadHeader wisp={w} orgName={null} wideningAvailable={false} />);
    expect(screen.getByTestId('wisp-grant-status')).toHaveAttribute('aria-label', 'Paused');
  });

  it('pause merges the server answer into the store by default', async () => {
    render(<Rail wisp={wisp()} orgName={null} wideningAvailable={false} />);
    fireEvent.click(screen.getByTestId('wisp-pause'));
    await waitFor(() => expect(h.updateWisp).toHaveBeenCalledWith({ status: 'paused', pausedReason: 'user_paused' }));
  });

  it('caller-owned state (the rail): patches go to onWispChange (not the store), revoke calls onRevoked, and no focus switcher', async () => {
    const onWispChange = vi.fn();
    const onRevoked = vi.fn();
    render(
      <Rail wisp={wisp()} orgName={null} wideningAvailable={false} onWispChange={onWispChange} onRevoked={onRevoked} />,
    );
    expect(screen.queryByTestId('wisp-focus')).toBeNull();
    fireEvent.click(screen.getByTestId('wisp-pause'));
    await waitFor(() => expect(onWispChange).toHaveBeenCalledWith({ status: 'paused', pausedReason: 'user_paused' }));
    expect(h.updateWisp).not.toHaveBeenCalled();

    h.fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    fireEvent.click(screen.getByTestId('wisp-revoke'));
    fireEvent.click(await screen.findByTestId('wisp-revoke-confirm'));
    await waitFor(() => expect(onRevoked).toHaveBeenCalledTimes(1));
    expect(h.exitWispMode).not.toHaveBeenCalled();
  });

  // #10142: a session's grant revision is immutable, so a refresh never
  // reaches the conversation already open — say so and offer a fresh one.
  describe('after "Refresh grant"', () => {
    const refreshTo = async (fresh: NonNullable<WispState>) => {
      fireEvent.click(screen.getByTestId('wisp-refresh-grant'));
      await act(async () => { (h.modalProps!.onGranted as (w: unknown) => void)(fresh); });
    };

    it('tells the user the open conversation keeps the previous terms and starts a new one on request', async () => {
      h.chat = { sessionId: 's-open', wisp: { grantId: 'g-1' } };
      render(<Rail wisp={wisp()} orgName={null} wideningAvailable />);
      const fresh = wisp({ expiresAt: '2027-04-01T00:00:00.000Z' });
      await refreshTo(fresh);
      expect(screen.getByTestId('wisp-refresh-hint')).toHaveTextContent('This conversation keeps the previous grant terms');
      fireEvent.click(screen.getByTestId('wisp-refresh-new-conversation'));
      await waitFor(() => expect(h.enterWispMode).toHaveBeenCalledWith(fresh));
      expect(h.closeSession).toHaveBeenCalledTimes(1);
      expect(h.closeSession.mock.invocationCallOrder[0]).toBeLessThan(h.enterWispMode.mock.invocationCallOrder[0]);
      await waitFor(() => expect(screen.queryByTestId('wisp-refresh-hint')).toBeNull());
    });

    it('says nothing when no conversation is open under this grant', async () => {
      h.chat = { sessionId: 's-other', wisp: { grantId: 'g-other' } };
      render(<Rail wisp={wisp()} orgName={null} wideningAvailable />);
      await refreshTo(wisp());
      expect(screen.queryByTestId('wisp-refresh-hint')).toBeNull();
    });

    it('the note can be dismissed without starting over', async () => {
      h.chat = { sessionId: 's-open', wisp: { grantId: 'g-1' } };
      render(<Rail wisp={wisp()} orgName={null} wideningAvailable />);
      await refreshTo(wisp());
      fireEvent.click(screen.getByTestId('wisp-refresh-hint-dismiss'));
      expect(screen.queryByTestId('wisp-refresh-hint')).toBeNull();
      expect(h.enterWispMode).not.toHaveBeenCalled();
    });
  });
});

describe('Wisp grant controls — model-written session notes switch (#10390)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.modalProps = null;
    h.chat = { sessionId: null, wisp: null };
    h.runAction.mockImplementation(async (o: { request: () => Promise<Response> }) => (await o.request()).json());
    h.fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'g-1', summaryRefine: true }) });
  });

  const open = (w = wisp()) => {
    render(<Rail wisp={w} orgName={null} wideningAvailable={false} />);
    fireEvent.click(screen.getByTestId('wisp-settings'));
    return screen.getByTestId('wisp-settings-summary-refine');
  };

  it('sits in its own section, outside the budget/tick form, off by default, and says it spends budget', () => {
    const section = open();
    expect(screen.getByTestId('wisp-summary-refine-switch')).toHaveAttribute('aria-checked', 'false');
    expect(section.contains(screen.getByTestId('wisp-settings-save'))).toBe(false);
    expect(section.textContent).toMatch(/daily budget/i);
  });

  it('turning it on autosaves through runAction with a toast and no step-up, and the store follows', async () => {
    open();
    await act(async () => { fireEvent.click(screen.getByTestId('wisp-summary-refine-switch')); });
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/grants/g-1/settings', { method: 'PATCH', body: JSON.stringify({ summaryRefine: true }) });
    const action = h.runAction.mock.calls[0]![0] as { successMessage?: string; errorFallback?: string };
    expect(action.successMessage).toBe('Session notes turned on');
    expect(action.errorFallback).toBe("Couldn't change session notes");
    expect(h.updateWisp).toHaveBeenCalledWith({ summaryRefine: true });
    expect(screen.queryByTestId('wisp-refresh-modal-mock')).toBeNull();
  });

  it('turning it off autosaves the same way', async () => {
    h.fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'g-1', summaryRefine: false }) });
    open(wisp({ summaryRefine: true }));
    expect(screen.getByTestId('wisp-summary-refine-switch')).toHaveAttribute('aria-checked', 'true');
    await act(async () => { fireEvent.click(screen.getByTestId('wisp-summary-refine-switch')); });
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/grants/g-1/settings', { method: 'PATCH', body: JSON.stringify({ summaryRefine: false }) });
    const action = h.runAction.mock.calls[0]![0] as { successMessage?: string };
    expect(action.successMessage).toBe('Session notes turned off');
    expect(h.updateWisp).toHaveBeenCalledWith({ summaryRefine: false });
  });

  it('a failure toasts once, leaves the store alone, and the switch keeps its value', async () => {
    const { showToast } = await import('@/components/shared/Toast');
    h.runAction.mockRejectedValueOnce(new Error('network'));
    open();
    await act(async () => { fireEvent.click(screen.getByTestId('wisp-summary-refine-switch')); });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: "Couldn't change session notes" }));
    expect(h.updateWisp).not.toHaveBeenCalled();
    expect(screen.getByTestId('wisp-summary-refine-switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('a 401 is silent: the auth redirect handles it', async () => {
    const { ActionError } = await import('@/lib/runAction');
    const { showToast } = await import('@/components/shared/Toast');
    const unauthorized = Object.assign(new (ActionError as unknown as new (message: string) => Error)('unauthorized'), { status: 401 });
    h.runAction.mockRejectedValueOnce(unauthorized);
    open();
    await act(async () => { fireEvent.click(screen.getByTestId('wisp-summary-refine-switch')); });
    expect(showToast).not.toHaveBeenCalled();
    expect(h.updateWisp).not.toHaveBeenCalled();
  });
});

describe('Wisp grant controls — unattended reads switch (#10973)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.modalProps = null;
    h.chat = { sessionId: null, wisp: null };
    h.runAction.mockImplementation(async (o: { request: () => Promise<Response> }) => (await o.request()).json());
    h.fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'g-1', unattendedReads: false, unattendedReadsPinned: true }) });
  });

  const open = (w = wisp()) => {
    render(<Rail wisp={w} orgName={null} wideningAvailable={false} />);
    fireEvent.click(screen.getByTestId('wisp-settings'));
    return screen.getByTestId('wisp-settings-unattended-reads');
  };

  it('sits in its own section, outside the budget/tick form, off by default, and names the four reads', () => {
    const section = open();
    const toggle = screen.getByTestId('wisp-unattended-reads-switch');
    expect(toggle).toHaveAttribute('role', 'switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(section).not.toContainElement(screen.getByTestId('wisp-settings-save'));
    expect(section).not.toContainElement(screen.getByTestId('wisp-settings-budget'));
    for (const text of ['Read a registry key', 'Read a registry value', 'Search the Security event log', 'Save a note about a device']) {
      expect(section).toHaveTextContent(text);
    }
    expect(section).toHaveTextContent('Applies to new conversations and new background runs.');
  });

  it('turning it on opens the step-up modal in refresh mode with the flag, and PATCHes nothing', () => {
    open(wisp({ scopeOrgId: 'org-a' }));
    fireEvent.click(screen.getByTestId('wisp-unattended-reads-switch'));
    expect(screen.getByTestId('wisp-refresh-modal-mock')).toBeInTheDocument();
    expect(h.modalProps?.refresh).toEqual({ grantId: 'g-1', orgId: 'org-a', unattendedReads: true });
    expect(h.runAction).not.toHaveBeenCalled();
  });

  it('the modal granting merges the switched-on grant into the store', async () => {
    open();
    fireEvent.click(screen.getByTestId('wisp-unattended-reads-switch'));
    const fresh = wisp({ unattendedReads: true });
    await act(async () => { (h.modalProps!.onGranted as (w: unknown) => void)(fresh); });
    expect(h.updateWisp).toHaveBeenCalledWith(fresh);
  });

  it('a committed refresh merges the switch at once, before the thread read can fail', async () => {
    open();
    fireEvent.click(screen.getByTestId('wisp-unattended-reads-switch'));
    await act(async () => { (h.modalProps!.onRefreshed as (g: unknown) => void)({ unattendedReads: true }); });
    expect(h.updateWisp).toHaveBeenCalledWith({ unattendedReads: true });
  });

  it('a cancelled turn-on leaves no flag behind for the next plain refresh', () => {
    open();
    fireEvent.click(screen.getByTestId('wisp-unattended-reads-switch'));
    expect(h.modalProps?.refresh).toMatchObject({ unattendedReads: true });
    act(() => { (h.modalProps!.onClose as () => void)(); });
    fireEvent.click(screen.getByTestId('wisp-refresh-grant'));
    expect(h.modalProps?.refresh).toEqual({ grantId: 'g-1', orgId: null });
  });

  it('the plain Refresh button carries no flag: the server keeps the switch as it is', () => {
    render(<Rail wisp={wisp({ unattendedReads: true })} orgName={null} wideningAvailable={false} />);
    fireEvent.click(screen.getByTestId('wisp-refresh-grant'));
    expect(h.modalProps?.refresh).toEqual({ grantId: 'g-1', orgId: null });
  });

  it('turning it off autosaves through runAction with a toast, and the store follows', async () => {
    open(wisp({ unattendedReads: true }));
    expect(screen.getByTestId('wisp-unattended-reads-switch')).toHaveAttribute('aria-checked', 'true');
    await act(async () => { fireEvent.click(screen.getByTestId('wisp-unattended-reads-switch')); });
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/grants/g-1/settings', { method: 'PATCH', body: JSON.stringify({ unattendedReads: false }) });
    const action = h.runAction.mock.calls[0]![0] as { successMessage?: string; errorFallback?: string };
    expect(action.successMessage).toBe('Unattended reads turned off');
    expect(action.errorFallback).toBe("Couldn't turn off unattended reads");
    expect(h.updateWisp).toHaveBeenCalledWith({ unattendedReads: false });
    expect(screen.queryByTestId('wisp-refresh-modal-mock')).toBeNull();
  });

  it('a 401 while turning it off is silent (the auth redirect handles it) and changes nothing', async () => {
    const { ActionError } = await import('@/lib/runAction');
    const { showToast } = await import('@/components/shared/Toast');
    const unauthorized = Object.assign(new (ActionError as unknown as new (message: string) => Error)('unauthorized'), { status: 401 });
    h.runAction.mockRejectedValueOnce(unauthorized);
    open(wisp({ unattendedReads: true }));
    await act(async () => { fireEvent.click(screen.getByTestId('wisp-unattended-reads-switch')); });
    expect(showToast).not.toHaveBeenCalled();
    expect(h.updateWisp).not.toHaveBeenCalled();
  });

  it('a non-ActionError failure while turning it off toasts once', async () => {
    const { showToast } = await import('@/components/shared/Toast');
    h.runAction.mockRejectedValueOnce(new Error('network'));
    open(wisp({ unattendedReads: true }));
    await act(async () => { fireEvent.click(screen.getByTestId('wisp-unattended-reads-switch')); });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: "Couldn't turn off unattended reads" }));
    expect(h.updateWisp).not.toHaveBeenCalled();
  });
});

// Critique: the docked pane's Wisp header collapses ~7 stacked rows into two —
// Row A (identity + one overflow menu) and Row B (focus chip + spend chip) —
// plus at most one escalation notice. The rail lays the controls out in its card.
describe('WispThreadHeader (the docked pane\'s header)', () => {
  const RESETS = '2099-01-01T00:00:00.000Z';
  const usage = (over: Record<string, unknown> = {}) => ({
    daily: { totalCostCents: 0, messageCount: 0 },
    monthly: { totalCostCents: 1002, messageCount: 153 },
    budget: null,
    credits: { remaining: 8570, includedBalance: 0, purchasedBalance: 8570, fetchedAt: '2026-11-08T00:00:00.000Z' },
    ...over,
  });
  let usageBody: unknown = usage();

  beforeEach(() => {
    vi.clearAllMocks();
    h.modalProps = null;
    h.chat = { sessionId: null, wisp: null };
    h.limits = { maxGrants: 25, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 20 };
    usageBody = usage();
    h.runAction.mockImplementation(async (o: { request: () => Promise<Response> }) => (await o.request()).json());
    h.fetchWithAuth.mockImplementation(async (url: string) => (url === '/ai/usage'
      ? { ok: true, status: 200, json: async () => usageBody }
      : { ok: true, status: 200, json: async () => ({ success: true, status: 'paused', pausedReason: 'user_paused' }) }));
  });

  const compact = (w = wisp(), extra: Record<string, unknown> = {}) =>
    render(<WispThreadHeader wisp={w} orgName={null} wideningAvailable={w.wideningAvailable} {...extra} />);
  const openMenu = () => {
    fireEvent.click(screen.getByTestId('wisp-header-menu'));
    return screen.getByRole('menu');
  };

  it('Row A: the Wisp title, a status dot and the scope share one line; pane actions and Close flank the overflow menu', () => {
    compact(wisp(), {
      paneActions: <button type="button" data-testid="pane-history">h</button>,
      closeAction: <button type="button" data-testid="pane-close">x</button>,
    });
    const header = screen.getByTestId('wisp-thread-header');
    expect(within(header).getByText('Wisp')).toBeInTheDocument();
    expect(screen.getByTestId('wisp-scope').textContent).toBe('All organizations');
    const dot = screen.getByTestId('wisp-grant-status');
    expect(dot).toHaveAttribute('aria-label', 'Active');
    expect(dot).toHaveAttribute('data-status', 'active');
    // The 10px badge is gone: an active grant shows the dot only.
    expect(within(header).queryByText('Active')).toBeNull();
    const order = [screen.getByTestId('pane-history'), screen.getByTestId('wisp-header-menu'), screen.getByTestId('pane-close')];
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The old inline rows are gone from the default view.
    expect(screen.queryByTestId('wisp-pause-control')).toBeNull();
    expect(screen.queryByTestId('wisp-settings-panel')).toBeNull();
  });

  it('a paused grant names its status in text beside the dot (at least 12px)', () => {
    compact(wisp({ status: 'paused', pausedReason: 'user_paused' }));
    const dot = screen.getByTestId('wisp-grant-status');
    expect(dot).toHaveAttribute('data-status', 'paused');
    const text = screen.getByTestId('wisp-grant-status-text');
    expect(text.textContent).toBe('Paused');
    expect(text.closest('.text-xs')).not.toBeNull();
    expect(text.className).not.toContain('text-[10px]');
  });

  it('the overflow menu holds Open Wisp home, the pane items, Budget & check-ins, Refresh grant, then a destructive Turn off Wisp', () => {
    const onFlag = vi.fn();
    compact(wisp(), { paneMenuItems: [{ id: 'flag', label: 'Flag conversation for review', testId: 'ai-chat-flag', onSelect: onFlag }] });
    const menu = openMenu();
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Open Wisp home',
      'Flag conversation for review',
      'Budget & check-ins…',
      'Refresh grant…',
      'Turn off Wisp…',
    ]);
    const home = screen.getByTestId('wisp-sidebar-open-home');
    expect(home).toHaveAttribute('href', '/wisp');
    expect(home).not.toHaveAttribute('target');
    expect(home.querySelector('svg')).toBeNull();
    const off = screen.getByTestId('wisp-revoke');
    expect(off.className).toContain('text-destructive');
    expect(off.previousElementSibling).toHaveAttribute('role', 'separator');
    fireEvent.click(screen.getByTestId('ai-chat-flag'));
    expect(onFlag).toHaveBeenCalledTimes(1);
  });

  it('Budget & check-ins opens the settings as an overlay dialog, not inline; it still saves, and Escape closes it', async () => {
    h.fetchWithAuth.mockImplementation(async (url: string) => (url === '/ai/usage'
      ? { ok: true, status: 200, json: async () => usageBody }
      : { ok: true, status: 200, json: async () => ({ id: 'g-1', budgetCentsPerDay: 250, floorTickMinutes: 30 }) }));
    compact();
    openMenu();
    fireEvent.click(screen.getByTestId('wisp-settings'));
    const dialog = screen.getByRole('dialog', { name: 'Budget and check-in' });
    expect(dialog).toContainElement(screen.getByTestId('wisp-settings-panel'));
    expect(dialog.className).toContain('absolute');
    expect(screen.getByTestId('wisp-settings-budget')).toHaveFocus();
    fireEvent.change(screen.getByTestId('wisp-settings-budget'), { target: { value: '2.50' } });
    fireEvent.click(screen.getByTestId('wisp-settings-save'));
    await waitFor(() => expect(h.updateWisp).toHaveBeenCalledWith({ budgetCentsPerDay: 250, floorTickMinutes: 30 }));
    openMenu();
    fireEvent.click(screen.getByTestId('wisp-settings'));
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Budget and check-in' }), { key: 'Escape' });
    expect(screen.queryByTestId('wisp-settings-panel')).toBeNull();
  });

  it('Refresh grant opens the step-up modal and Turn off Wisp still asks before revoking', async () => {
    compact(wisp({ scopeOrgId: 'org-a' }), { orgName: 'Alpha' });
    openMenu();
    fireEvent.click(screen.getByTestId('wisp-refresh-grant'));
    expect(screen.getByTestId('wisp-refresh-modal-mock')).toBeInTheDocument();
    expect(h.modalProps?.refresh).toEqual({ grantId: 'g-1', orgId: 'org-a' });
    act(() => { (h.modalProps!.onClose as () => void)(); });

    h.fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
    openMenu();
    fireEvent.click(screen.getByTestId('wisp-revoke'));
    expect(h.runAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('wisp-revoke-confirm'));
    await waitFor(() => expect(h.exitWispMode).toHaveBeenCalledTimes(1));
  });

  it('renders only one notice when several conditions hold: a paused grant over budget shows the pause, not the budget', () => {
    compact(wisp({ status: 'paused', pausedReason: 'user_paused', spentTodayCents: 300, budgetResetsAt: RESETS, wideningAvailable: true }));
    const notices = screen.getAllByTestId('wisp-header-notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toHaveAttribute('data-kind', 'userPaused');
    expect(notices[0]).toHaveTextContent("You paused Wisp. It won't check in or nudge you until you resume.");
    expect(within(notices[0]!).getByTestId('wisp-resume')).toBeEnabled();
    expect(screen.queryByTestId('wisp-spend-raise')).toBeNull();
    expect(screen.queryByTestId('wisp-widening')).toBeNull();
  });

  it('a partner-disabled grant names the reason in the notice, with no Resume', () => {
    compact(wisp({ status: 'paused', pausedReason: 'partner_disabled' }));
    const notice = screen.getByTestId('wisp-header-notice');
    expect(notice).toHaveAttribute('data-kind', 'systemPaused');
    expect(notice).toHaveTextContent('Wisp is turned off for your partner. An administrator can turn it back on.');
    expect(screen.queryByTestId('wisp-resume')).toBeNull();
  });

  it('an active grant over budget shows the budget notice, whose Raise opens the settings overlay', () => {
    compact(wisp({ spentTodayCents: 200, budgetResetsAt: RESETS }));
    const notice = screen.getByTestId('wisp-header-notice');
    expect(notice).toHaveAttribute('data-kind', 'budget');
    expect(notice).toHaveTextContent('Budget reached');
    fireEvent.click(within(notice).getByTestId('wisp-spend-raise'));
    expect(screen.getByRole('dialog', { name: 'Budget and check-in' })).toBeInTheDocument();
  });

  it('widening puts a primary Refresh grant in the notice strip; the menu keeps its own Refresh grant', () => {
    compact(wisp({ wideningAvailable: true }));
    const notice = screen.getByTestId('wisp-header-notice');
    expect(notice).toHaveAttribute('data-kind', 'widening');
    expect(within(notice).getByTestId('wisp-widening')).toHaveTextContent('You can do more than this grant allows');
    const primary = within(notice).getByTestId('wisp-widening-refresh');
    expect(primary.className).toContain('bg-primary');
    fireEvent.click(primary);
    expect(screen.getByTestId('wisp-refresh-modal-mock')).toBeInTheDocument();
    act(() => { (h.modalProps!.onClose as () => void)(); });
    openMenu();
    expect(screen.getByTestId('wisp-refresh-grant')).toBeInTheDocument();
  });

  it('no notice at all for a healthy grant', async () => {
    compact(wisp({ spentTodayCents: 10, budgetResetsAt: RESETS }));
    await waitFor(() => expect(h.fetchWithAuth).toHaveBeenCalledWith('/ai/usage'));
    expect(screen.queryByTestId('wisp-header-notice')).toBeNull();
  });

  it('out of AI credits shows the credits notice', async () => {
    usageBody = usage({ credits: { remaining: 0, includedBalance: 0, purchasedBalance: 0, fetchedAt: '2026-11-08T00:00:00.000Z' } });
    compact();
    const notice = await screen.findByTestId('wisp-header-notice');
    expect(notice).toHaveAttribute('data-kind', 'credits');
    expect(notice).toHaveTextContent("You're out of AI credits.");
  });

  const NO_CREDITS = { credits: { remaining: 0, includedBalance: 0, purchasedBalance: 0, fetchedAt: '2026-11-08T00:00:00.000Z' } };
  const usageLanded = async () => {
    await waitFor(() => expect(h.fetchWithAuth).toHaveBeenCalledWith('/ai/usage'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };

  it('a refused send\'s banner already offers Buy credits: the credits notice stays quiet while it shows', async () => {
    usageBody = usage(NO_CREDITS);
    h.chat = { sessionId: 's-1', wisp: null, error: 'Out of AI credits', errorCode: 'credits_exhausted' };
    compact();
    await usageLanded();
    expect(screen.queryByTestId('wisp-header-notice')).toBeNull();
  });

  // switchSession / loadSession clear the banner; a code left without one must not hide the notice.
  it('a credits code with no banner (another conversation since) does not hide the credits notice', async () => {
    usageBody = usage(NO_CREDITS);
    h.chat = { sessionId: 's-2', wisp: null, error: null, errorCode: 'credits_exhausted' };
    compact();
    const notice = await screen.findByTestId('wisp-header-notice');
    expect(notice).toHaveAttribute('data-kind', 'credits');
  });

  it('the spend chip reads "$0.42 / $2" and opens a popover with the meter, all-AI usage, credits and the Pause control', async () => {
    compact(wisp({ spentTodayCents: 42, budgetResetsAt: RESETS }));
    const chip = screen.getByTestId('wisp-spend-chip');
    expect(chip.textContent).toMatch(/\$0\.42 \/ \$2(?!\.)/);
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog');
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    const pop = screen.getByTestId('wisp-spend-popover');
    expect(pop).toHaveAttribute('role', 'dialog');
    expect(within(pop).getByTestId('wisp-spend-meter')).toHaveTextContent('$0.42 of $2.00 today');
    await waitFor(() => expect(pop).toHaveTextContent('All AI this month: $10.02'));
    expect(pop).toHaveTextContent('153 msgs');
    expect(pop).toHaveTextContent('8,570 credits');
    fireEvent.click(within(pop).getByTestId('wisp-pause'));
    await waitFor(() => expect(h.updateWisp).toHaveBeenCalledWith({ status: 'paused', pausedReason: 'user_paused' }));
    fireEvent.keyDown(pop, { key: 'Escape' });
    expect(screen.queryByTestId('wisp-spend-popover')).toBeNull();
    expect(chip).toHaveFocus();
  });

  it('the popover closes on an outside click', () => {
    compact(wisp({ spentTodayCents: 42, budgetResetsAt: RESETS }));
    fireEvent.click(screen.getByTestId('wisp-spend-chip'));
    expect(screen.getByTestId('wisp-spend-popover')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('wisp-spend-popover')).toBeNull();
  });

  it('Row B keeps the native focus select as a compact chip, with its in-flight lock', async () => {
    let release!: () => void;
    h.setWispFocus.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    compact();
    const select = screen.getByTestId('wisp-focus') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.className).not.toContain('flex-1');
    expect(select.selectedOptions[0]!.textContent).toBe('No customer focus');
    fireEvent.change(select, { target: { value: 'org-b' } });
    expect(h.setWispFocus).toHaveBeenCalledWith('org-b', 'Bravo');
    expect(select).toBeDisabled();
    await act(async () => { release(); });
    expect(select).toBeEnabled();
  });
});
