/**
 * W08 (#9921) — the partner "Allow Wisp" switch (w00 A35; settings rule 9:
 * home Settings → AI Agents, partner level only, one place). Autosave with a
 * toast (rule 7): the PUT goes through runAction.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionError } from '@/lib/runAction';

const h = vi.hoisted(() => ({
  server: true,
  claims: { status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } } as Record<string, unknown>,
  entitlement: 'enabled' as string,
  canManagePartnerWide: true as boolean | undefined,
  get: vi.fn(),
  set: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock('@/lib/wispVisibility', () => ({ useWispEnabled: () => h.server }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => h.claims }));
vi.mock('@/hooks/useEntitlement', () => ({ useEntitlement: () => ({ state: h.entitlement }) }));
vi.mock('@/stores/auth', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { canManagePartnerWide: h.canManagePartnerWide } }),
}));
vi.mock('@/lib/wispPartnerSettingsApi', () => ({ getWispPartnerEnabled: h.get, setWispPartnerEnabled: h.set }));
vi.mock('@/components/shared/Toast', () => ({ showToast: h.showToast }));

import WispPartnerSettingsCard from './WispPartnerSettingsCard';

describe('WispPartnerSettingsCard (W08)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.server = true;
    h.claims = { status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } };
    h.entitlement = 'enabled';
    h.canManagePartnerWide = true;
    h.get.mockResolvedValue(true);
  });

  it.each([
    ['the server flag is off', () => { h.server = false; }],
    ['the token is org-scoped', () => { h.claims = { status: 'resolved', claims: { scope: 'organization', partnerId: 'p-1', orgId: 'o-1' } }; }],
    ['the partner is not entitled', () => { h.entitlement = 'locked'; }],
  ])('renders nothing and reads nothing when %s (flag off = no change to the page)', async (_why, arrange) => {
    arrange();
    const { container } = render(<WispPartnerSettingsCard />);
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
    expect(h.get).not.toHaveBeenCalled();
  });

  it('shows the stored value; an admin flips it with autosave', async () => {
    h.set.mockResolvedValue(false);
    render(<WispPartnerSettingsCard />);
    const toggle = await screen.findByRole('switch', { name: 'Allow Wisp' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(toggle);
    await waitFor(() => expect(h.set).toHaveBeenCalledWith(false));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
  });

  it('a refused save (ActionError, already toasted) keeps the old value; no second toast', async () => {
    h.set.mockRejectedValue(new ActionError('Only partner admins', 403, 'partner_admin_required'));
    render(<WispPartnerSettingsCard />);
    const toggle = await screen.findByRole('switch', { name: 'Allow Wisp' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(toggle);
    await waitFor(() => expect(h.set).toHaveBeenCalled());
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(h.showToast).not.toHaveBeenCalled();
  });

  it('a non-admin sees the value read-only with the reason', async () => {
    h.canManagePartnerWide = false;
    render(<WispPartnerSettingsCard />);
    const toggle = await screen.findByRole('switch', { name: 'Allow Wisp' });
    expect(toggle).toBeDisabled();
    expect(screen.getByTestId('wisp-partner-switch-admin-only')).toHaveTextContent('Only partner administrators can change this.');
  });

  it('a failed read shows an error, never a guessed value', async () => {
    h.get.mockRejectedValue(new Error('500'));
    render(<WispPartnerSettingsCard />);
    expect(await screen.findByTestId('wisp-partner-switch-load-error')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
