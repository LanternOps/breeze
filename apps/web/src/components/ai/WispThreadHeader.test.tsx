import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WispState } from '@/stores/aiStore';

const h = vi.hoisted(() => ({
  runAction: vi.fn(),
  fetchWithAuth: vi.fn(),
  exitWispMode: vi.fn(),
  setWispFocus: vi.fn(),
  updateWisp: vi.fn(),
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
vi.mock('@/stores/auth', () => ({ fetchWithAuth: h.fetchWithAuth }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/hooks/useEntitlement', () => ({ useEntitlement: () => ({ state: 'enabled', limits: h.limits }) }));
vi.mock('@/stores/orgStore', () => ({ useOrgStore: (sel: (s: unknown) => unknown) => sel({ organizations: h.orgs }) }));
vi.mock('@/stores/aiStore', () => ({
  useAiStore: (sel: (s: unknown) => unknown) =>
    sel({ exitWispMode: h.exitWispMode, setWispFocus: h.setWispFocus, updateWisp: h.updateWisp }),
}));
vi.mock('./WispGrantStepUpModal', () => ({
  default: (props: Record<string, unknown>) => {
    h.modalProps = props;
    return props.open ? <div data-testid="wisp-refresh-modal-mock" /> : null;
  },
}));

import WispThreadHeader from './WispThreadHeader';

function wisp(overrides: Partial<NonNullable<WispState>> = {}): NonNullable<WispState> {
  return {
    grantId: 'g-1', threadId: 't-1', scopeOrgId: null, focusOrgId: null, focusOrgName: null, status: 'active',
    expiresAt: '2027-01-01T00:00:00.000Z', summary: '', budgetCentsPerDay: 200, floorTickMinutes: 30, wideningAvailable: false,
    ...overrides,
  };
}

describe('WispThreadHeader (W04 Task 8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.modalProps = null;
    h.limits = { maxGrants: 25, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 20 };
    h.runAction.mockImplementation(async (o: { request: () => Promise<Response> }) => {
      const r = await o.request();
      return r.json();
    });
    h.fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });
  });

  it('shows "All organizations" for a partner-wide grant and the org name for an org grant', () => {
    const { rerender } = render(<WispThreadHeader wisp={wisp()} orgName={null} wideningAvailable={false} />);
    expect(screen.getByTestId('wisp-scope').textContent).toBe('All organizations');
    rerender(<WispThreadHeader wisp={wisp({ scopeOrgId: 'org-a' })} orgName="Alpha" wideningAvailable={false} />);
    expect(screen.getByTestId('wisp-scope').textContent).toBe('Alpha');
  });

  it.each([
    ['active', 'Active'],
    ['paused', 'Paused'],
    ['revoked', 'Revoked'],
    ['expired', 'Expired'],
  ] as const)('shows the status badge text for %s', (status, text) => {
    render(<WispThreadHeader wisp={wisp({ status })} orgName={null} wideningAvailable={false} />);
    expect(screen.getByTestId('wisp-grant-status').textContent).toBe(text);
  });

  it('revoke asks for confirmation, posts /wisp/grants/:id/revoke through runAction and exits Wisp mode', async () => {
    render(<WispThreadHeader wisp={wisp()} orgName={null} wideningAvailable={false} />);
    fireEvent.click(screen.getByTestId('wisp-revoke'));
    expect(h.runAction).not.toHaveBeenCalled();
    expect(screen.getByText('Turn off Wisp for this scope? Open threads stay readable.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('wisp-revoke-confirm'));
    await waitFor(() => expect(h.exitWispMode).toHaveBeenCalledTimes(1));
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/grants/g-1/revoke', { method: 'POST' });
    expect(h.runAction).toHaveBeenCalledWith(expect.objectContaining({ successMessage: 'Wisp is off', errorFallback: 'Could not turn off Wisp' }));
  });

  it('a refused revoke keeps Wisp mode on', async () => {
    h.runAction.mockRejectedValueOnce(new Error('boom'));
    render(<WispThreadHeader wisp={wisp()} orgName={null} wideningAvailable={false} />);
    fireEvent.click(screen.getByTestId('wisp-revoke'));
    fireEvent.click(screen.getByTestId('wisp-revoke-confirm'));
    await waitFor(() => expect(h.runAction).toHaveBeenCalled());
    expect(h.exitWispMode).not.toHaveBeenCalled();
  });

  it('refresh button is primary with the widening line when wideningAvailable and secondary without it otherwise', () => {
    const { rerender } = render(<WispThreadHeader wisp={wisp()} orgName={null} wideningAvailable />);
    expect(screen.getByTestId('wisp-refresh-grant')).toHaveAttribute('data-variant', 'primary');
    expect(screen.getByTestId('wisp-widening')).toBeInTheDocument();
    rerender(<WispThreadHeader wisp={wisp()} orgName={null} wideningAvailable={false} />);
    expect(screen.getByTestId('wisp-refresh-grant')).toHaveAttribute('data-variant', 'secondary');
    expect(screen.queryByTestId('wisp-widening')).toBeNull();
  });

  it('refresh opens the step-up modal for this grant and merges the refreshed grant into the store', async () => {
    render(<WispThreadHeader wisp={wisp({ scopeOrgId: 'org-a' })} orgName="Alpha" wideningAvailable />);
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
    render(<WispThreadHeader wisp={wisp()} orgName={null} wideningAvailable={false} />);
    fireEvent.click(screen.getByTestId('wisp-settings'));
    const budget = screen.getByTestId('wisp-settings-budget') as HTMLInputElement;
    const tick = screen.getByTestId('wisp-settings-tick') as HTMLInputElement;
    expect(budget.max).toBe('1000');
    expect(tick.min).toBe('20');
    expect(tick.max).toBe('240');
    fireEvent.change(budget, { target: { value: '5000' } });
    fireEvent.click(screen.getByTestId('wisp-settings-save'));
    await waitFor(() => expect(h.updateWisp).toHaveBeenCalled());
    const [url, init] = h.fetchWithAuth.mock.calls.find(([u]) => u === '/wisp/grants/g-1/settings')!;
    expect(url).toBe('/wisp/grants/g-1/settings');
    expect(init).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ budgetCentsPerDay: 1000 });
    expect(h.updateWisp).toHaveBeenCalledWith({ budgetCentsPerDay: 1000, floorTickMinutes: 30 });
  });

  it('settings tick below the plan minimum is raised to it', async () => {
    h.fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'g-1', budgetCentsPerDay: 200, floorTickMinutes: 20 }) });
    render(<WispThreadHeader wisp={wisp()} orgName={null} wideningAvailable={false} />);
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
    render(<WispThreadHeader wisp={wisp()} orgName={null} wideningAvailable={false} />);
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
    render(<WispThreadHeader wisp={wisp()} orgName={null} wideningAvailable={false} />);
    fireEvent.click(screen.getByTestId('wisp-settings'));
    fireEvent.change(screen.getByTestId('wisp-settings-budget'), { target: { value: '900' } });
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
