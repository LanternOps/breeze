import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getPolicyMock, putPolicyMock, runActionMock } = vi.hoisted(() => ({
  getPolicyMock: vi.fn(),
  putPolicyMock: vi.fn(),
  runActionMock: vi.fn(),
}));

vi.mock('../../stores/authenticatorPolicy', () => ({
  getAuthenticatorPolicyState: getPolicyMock,
  putAuthenticatorPolicy: putPolicyMock,
}));
vi.mock('../../lib/runAction', () => ({
  runAction: runActionMock,
  ActionError: class ActionError extends Error {},
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import { OrgApprovalSecurityTab } from './OrgApprovalSecurityTab';

const PLATFORM_DEFAULT = { enforceFrom: '2026-11-05T00:00:00.000Z', enforcedTiers: ['high', 'critical'] };

function inheritingState(defaultNotice: 'upcoming' | 'active' = 'upcoming') {
  return {
    policy: { floorOverrides: {}, requireEnrollment: null, enforceFrom: null },
    effective: {
      source: 'platform_default',
      mode: defaultNotice === 'active' ? 'enforcing' : 'grace',
      requireEnrollment: true,
      enforceFrom: '2026-11-05T00:00:00.000Z',
      enforcedTiers: ['high', 'critical'],
      defaultNotice,
    },
    platformDefault: PLATFORM_DEFAULT,
  };
}

function explicitState(requireEnrollment: boolean, enforceFrom: string | null = null) {
  return {
    policy: { floorOverrides: {}, requireEnrollment, enforceFrom },
    effective: {
      source: 'explicit',
      mode: requireEnrollment ? 'enforcing' : 'off',
      requireEnrollment,
      enforceFrom,
      enforcedTiers: ['low', 'medium', 'high', 'critical'],
      defaultNotice: null,
    },
    platformDefault: PLATFORM_DEFAULT,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getPolicyMock.mockResolvedValue(inheritingState());
  runActionMock.mockImplementation(async (opts: { request: () => Promise<unknown> }) => opts.request());
  putPolicyMock.mockResolvedValue({ ok: true });
});

describe('OrgApprovalSecurityTab', () => {
  it('loads the policy and renders a per-tier control for all four tiers', async () => {
    render(<OrgApprovalSecurityTab />);
    await waitFor(() => expect(screen.getByTestId('approval-security-tab')).toBeTruthy());
    for (const tier of ['low', 'medium', 'high', 'critical']) {
      expect(screen.getByTestId(`level-${tier}`)).toBeTruthy();
    }
  });

  it('does not offer assurance levels below the Breeze floor (raise-only)', async () => {
    render(<OrgApprovalSecurityTab />);
    await waitFor(() => screen.getByTestId('level-critical'));
    // critical floor is L4 → the only option offered is 4
    const criticalSelect = screen.getByTestId('level-critical') as HTMLSelectElement;
    const options = Array.from(criticalSelect.options).map((o) => o.value);
    expect(options).toEqual(['4']);
    // high floor is L3 → options are 3 and 4 only
    const highSelect = screen.getByTestId('level-high') as HTMLSelectElement;
    expect(Array.from(highSelect.options).map((o) => o.value)).toEqual(['3', '4']);
  });

  it('with no explicit choice: shows "Platform default" selected and the inherited value with its source', async () => {
    render(<OrgApprovalSecurityTab />);
    await waitFor(() => screen.getByTestId('enforcement-choice'));
    expect((screen.getByTestId('enforcement-choice') as HTMLSelectElement).value).toBe('inherit');
    const inherited = screen.getByTestId('enforcement-inherited');
    expect(inherited.textContent).toMatch(/platform default/i);
    expect(inherited.textContent).toMatch(/high/i);
    expect(inherited.textContent).toMatch(/2026/);
    // The grace-date input only applies to an explicit Required choice.
    expect(screen.queryByTestId('enforce-from')).toBeNull();
  });

  it('with no explicit choice before the date: shows the upcoming default-enforcement notice', async () => {
    render(<OrgApprovalSecurityTab />);
    const notice = await screen.findByTestId('approver-assurance-default-notice');
    expect(notice.getAttribute('data-state')).toBe('upcoming');
    expect(notice.textContent).toMatch(/2026/);
    expect(notice.textContent).toMatch(/approver device/i);
  });

  it('with no explicit choice after the date: the notice explains why approvals ask for a device', async () => {
    getPolicyMock.mockResolvedValue(inheritingState('active'));
    render(<OrgApprovalSecurityTab />);
    const notice = await screen.findByTestId('approver-assurance-default-notice');
    expect(notice.getAttribute('data-state')).toBe('active');
  });

  it('with an explicit "not required" choice: selected as such, no default notice', async () => {
    getPolicyMock.mockResolvedValue(explicitState(false));
    render(<OrgApprovalSecurityTab />);
    await waitFor(() => screen.getByTestId('enforcement-choice'));
    expect((screen.getByTestId('enforcement-choice') as HTMLSelectElement).value).toBe('not_required');
    expect(screen.queryByTestId('approver-assurance-default-notice')).toBeNull();
    expect(screen.queryByTestId('enforcement-inherited')).toBeNull();
  });

  it('saves Required with the edited floor and grace date', async () => {
    render(<OrgApprovalSecurityTab />);
    await waitFor(() => screen.getByTestId('save-approval-security'));

    fireEvent.change(screen.getByTestId('level-medium'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('enforcement-choice'), { target: { value: 'required' } });
    fireEvent.change(screen.getByTestId('enforce-from'), { target: { value: '2026-12-01' } });
    fireEvent.click(screen.getByTestId('save-approval-security'));

    await waitFor(() => expect(putPolicyMock).toHaveBeenCalled());
    const saved = putPolicyMock.mock.calls[0][0];
    expect(saved.floorOverrides.medium).toBe(3);
    expect(saved.requireEnrollment).toBe(true);
    expect(saved.enforceFrom).toMatch(/^2026-12-01/);
  });

  it('saving without touching the enforcement choice keeps it blank (inherit), not "not required"', async () => {
    render(<OrgApprovalSecurityTab />);
    await waitFor(() => screen.getByTestId('save-approval-security'));
    fireEvent.change(screen.getByTestId('level-medium'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('save-approval-security'));
    await waitFor(() => expect(putPolicyMock).toHaveBeenCalled());
    expect(putPolicyMock.mock.calls[0][0]).toMatchObject({ requireEnrollment: null, enforceFrom: null });
  });

  it('saves an explicit "not required" choice as false and reloads the effective state', async () => {
    render(<OrgApprovalSecurityTab />);
    await waitFor(() => screen.getByTestId('save-approval-security'));
    fireEvent.change(screen.getByTestId('enforcement-choice'), { target: { value: 'not_required' } });
    fireEvent.click(screen.getByTestId('save-approval-security'));
    await waitFor(() => expect(putPolicyMock).toHaveBeenCalled());
    expect(putPolicyMock.mock.calls[0][0]).toMatchObject({ requireEnrollment: false, enforceFrom: null });
    await waitFor(() => expect(getPolicyMock).toHaveBeenCalledTimes(2));
  });

  it('switching back to Platform default saves a blank choice', async () => {
    getPolicyMock.mockResolvedValue(explicitState(true, '2026-10-01T00:00:00.000Z'));
    render(<OrgApprovalSecurityTab />);
    await waitFor(() => screen.getByTestId('enforcement-choice'));
    fireEvent.change(screen.getByTestId('enforcement-choice'), { target: { value: 'inherit' } });
    fireEvent.click(screen.getByTestId('save-approval-security'));
    await waitFor(() => expect(putPolicyMock).toHaveBeenCalled());
    expect(putPolicyMock.mock.calls[0][0]).toMatchObject({ requireEnrollment: null, enforceFrom: null });
  });

  it('shows an error state when the policy fails to load', async () => {
    getPolicyMock.mockRejectedValue(new Error('boom'));
    render(<OrgApprovalSecurityTab />);
    await waitFor(() => expect(screen.getByTestId('approval-security-error')).toBeTruthy());
  });
});
