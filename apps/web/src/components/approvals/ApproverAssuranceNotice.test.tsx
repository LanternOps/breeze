import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getPolicyMock, orgState } = vi.hoisted(() => ({
  getPolicyMock: vi.fn(),
  orgState: { currentOrgId: 'org-1' as string | null },
}));

vi.mock('../../stores/authenticatorPolicy', () => ({
  getAuthenticatorPolicyState: getPolicyMock,
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: () => orgState,
}));

import { ApproverAssuranceNotice } from './ApproverAssuranceNotice';

function state(defaultNotice: 'upcoming' | 'active' | null) {
  return {
    policy: { floorOverrides: {}, requireEnrollment: defaultNotice ? null : false, enforceFrom: null },
    effective: {
      source: defaultNotice ? 'platform_default' : 'explicit',
      mode: defaultNotice === 'active' ? 'enforcing' : defaultNotice ? 'grace' : 'off',
      requireEnrollment: Boolean(defaultNotice),
      enforceFrom: defaultNotice ? '2026-11-05T00:00:00.000Z' : null,
      enforcedTiers: defaultNotice ? ['high', 'critical'] : ['low', 'medium', 'high', 'critical'],
      defaultNotice,
    },
    platformDefault: { enforceFrom: '2026-11-05T00:00:00.000Z', enforcedTiers: ['high', 'critical'] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  orgState.currentOrgId = 'org-1';
});

describe('ApproverAssuranceNotice', () => {
  it('before the platform date: says when default enforcement starts and links to the setting and device registration', async () => {
    getPolicyMock.mockResolvedValue(state('upcoming'));
    render(<ApproverAssuranceNotice />);
    const notice = await screen.findByTestId('approver-assurance-default-notice');
    expect(notice.getAttribute('data-state')).toBe('upcoming');
    expect(notice.textContent).toMatch(/2026/);
    expect(notice.textContent).toMatch(/approver device/i);
    expect(screen.getByTestId('approver-assurance-settings-link').getAttribute('href')).toBe(
      '/settings/organizations/org-1#approval-security',
    );
    expect(screen.getByTestId('approver-assurance-register-link').getAttribute('href')).toBe('/settings/profile');
  });

  it('after the platform date: explains why an approval asks for a device', async () => {
    getPolicyMock.mockResolvedValue(state('active'));
    render(<ApproverAssuranceNotice />);
    const notice = await screen.findByTestId('approver-assurance-default-notice');
    expect(notice.getAttribute('data-state')).toBe('active');
    const upcoming = await (async () => {
      getPolicyMock.mockResolvedValue(state('upcoming'));
      const { container } = render(<ApproverAssuranceNotice />);
      await waitFor(() => expect(container.querySelector('[data-state="upcoming"]')).not.toBeNull());
      return container.querySelector('[data-state="upcoming"]')!.textContent;
    })();
    expect(notice.textContent).not.toBe(upcoming);
  });

  it('renders nothing for a partner with an explicit choice', async () => {
    getPolicyMock.mockResolvedValue(state(null));
    const { container } = render(<ApproverAssuranceNotice />);
    await waitFor(() => expect(getPolicyMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when the viewer cannot read the policy', async () => {
    getPolicyMock.mockRejectedValue(new Error('403'));
    const { container } = render(<ApproverAssuranceNotice />);
    await waitFor(() => expect(getPolicyMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.innerHTML).toBe('');
  });

  it('omits the settings link when no organization is selected', async () => {
    orgState.currentOrgId = null;
    getPolicyMock.mockResolvedValue(state('upcoming'));
    render(<ApproverAssuranceNotice />);
    await screen.findByTestId('approver-assurance-default-notice');
    expect(screen.queryByTestId('approver-assurance-settings-link')).toBeNull();
  });
});
