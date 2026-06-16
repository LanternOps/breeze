import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getPolicyMock, putPolicyMock, runActionMock } = vi.hoisted(() => ({
  getPolicyMock: vi.fn(),
  putPolicyMock: vi.fn(),
  runActionMock: vi.fn(),
}));

vi.mock('../../stores/authenticatorPolicy', () => ({
  getAuthenticatorPolicy: getPolicyMock,
  putAuthenticatorPolicy: putPolicyMock,
}));
vi.mock('../../lib/runAction', () => ({
  runAction: runActionMock,
  ActionError: class ActionError extends Error {},
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import { OrgApprovalSecurityTab } from './OrgApprovalSecurityTab';

beforeEach(() => {
  vi.clearAllMocks();
  getPolicyMock.mockResolvedValue({ floorOverrides: {}, requireEnrollment: false, enforceFrom: null });
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

  it('saves the edited policy via putAuthenticatorPolicy', async () => {
    render(<OrgApprovalSecurityTab />);
    await waitFor(() => screen.getByTestId('save-approval-security'));

    fireEvent.change(screen.getByTestId('level-medium'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('require-enrollment').querySelector('input')!);
    fireEvent.click(screen.getByTestId('save-approval-security'));

    await waitFor(() => expect(putPolicyMock).toHaveBeenCalled());
    const saved = putPolicyMock.mock.calls[0][0];
    expect(saved.floorOverrides.medium).toBe(3);
    expect(saved.requireEnrollment).toBe(true);
  });

  it('shows an error state when the policy fails to load', async () => {
    getPolicyMock.mockRejectedValue(new Error('boom'));
    render(<OrgApprovalSecurityTab />);
    await waitFor(() => expect(screen.getByTestId('approval-security-error')).toBeTruthy());
  });
});
