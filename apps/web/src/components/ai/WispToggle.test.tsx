import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  entitlement: { state: 'loading', failed: false, limits: null, source: null, why: null, graceUntil: null, reload: () => {} } as Record<string, unknown>,
  wispEnabled: true,
  claims: { status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } } as Record<string, unknown>,
  enterWispMode: vi.fn(),
  modalProps: null as null | Record<string, unknown>,
}));
vi.mock('@/hooks/useEntitlement', () => ({ useEntitlement: () => h.entitlement }));
vi.mock('@/lib/wispVisibility', () => ({ useWispEnabled: () => h.wispEnabled }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => h.claims }));
vi.mock('@/stores/orgStore', () => ({ useOrgStore: (sel: (s: unknown) => unknown) => sel({ currentOrgId: 'org-1' }) }));
vi.mock('@/stores/aiStore', () => ({
  useAiStore: (sel: (s: unknown) => unknown) => sel({ enterWispMode: h.enterWispMode, sessionOrgId: null }),
}));
vi.mock('./WispGrantStepUpModal', () => ({
  default: (props: Record<string, unknown>) => {
    h.modalProps = props;
    return props.open ? <div data-testid="wisp-grant-modal-mock" /> : null;
  },
}));

import WispToggle from './WispToggle';

describe('WispToggle (W04 Task 7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.wispEnabled = true;
    h.claims = { status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } };
    h.entitlement = { state: 'loading', failed: false, limits: null, source: null, why: null, graceUntil: null, reload: () => {} };
    h.modalProps = null;
  });

  it('renders nothing while the server has Wisp off (flag off = no change to the chat panel)', () => {
    h.wispEnabled = false;
    h.entitlement = { ...h.entitlement, state: 'enabled' };
    const { container } = render(<WispToggle />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an org-scoped token (grants are partner-staff only)', () => {
    h.claims = { status: 'resolved', claims: { scope: 'organization', partnerId: 'p-1', orgId: 'org-1' } };
    h.entitlement = { ...h.entitlement, state: 'enabled' };
    const { container } = render(<WispToggle />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the locked state with the plan copy and CTA when state is "locked"', () => {
    h.entitlement = { ...h.entitlement, state: 'locked', why: 'Registry why line' };
    render(<WispToggle />);
    expect(screen.getByTestId('wisp-toggle-locked')).toBeInTheDocument();
    expect(screen.getByText('Wisp is available on Pro and higher plans.')).toBeInTheDocument();
    expect(screen.getByTestId('wisp-toggle-locked-cta')).toHaveAttribute('href', '/settings/plan');
    fireEvent.click(screen.getByTestId('wisp-toggle'));
    expect(screen.queryByTestId('wisp-grant-modal-mock')).toBeNull();
  });

  it('renders a disabled control while loading (never enabled on fetch failure — D10 polarity)', () => {
    h.entitlement = { ...h.entitlement, state: 'loading', failed: true };
    render(<WispToggle />);
    expect(screen.getByTestId('wisp-toggle')).toBeDisabled();
    expect(screen.queryByTestId('wisp-toggle-locked')).toBeNull();
  });

  it('opens the step-up modal when enabled and clicked, defaulting to the selected org', () => {
    h.entitlement = { ...h.entitlement, state: 'enabled' };
    render(<WispToggle />);
    const button = screen.getByTestId('wisp-toggle');
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(screen.getByTestId('wisp-grant-modal-mock')).toBeInTheDocument();
    expect(h.modalProps?.defaultOrgId).toBe('org-1');
  });

  it('a granted thread enters Wisp mode and closes the modal', async () => {
    h.entitlement = { ...h.entitlement, state: 'enabled' };
    render(<WispToggle />);
    fireEvent.click(screen.getByTestId('wisp-toggle'));
    const w = { grantId: 'g-1', threadId: 't-1' };
    await act(async () => {
      await (h.modalProps!.onGranted as (x: unknown) => Promise<void>)(w);
    });
    expect(h.enterWispMode).toHaveBeenCalledWith(w);
    expect(screen.queryByTestId('wisp-grant-modal-mock')).toBeNull();
  });
});
