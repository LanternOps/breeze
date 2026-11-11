import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SsoOnlyConfirmDialog } from './SsoOnlyConfirmDialog';
import type { SsoOnlyImpact, StrandedPortalAccounts } from './types';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '33333333-3333-4333-8333-333333333333';

const impact = (flips: SsoOnlyImpact['flips'], digest = 'd1'): SsoOnlyImpact => ({ flips, impactDigest: digest });
const stranded = (n: number, total = n): StrandedPortalAccounts => ({
  items: Array.from({ length: n }, (_, i) => ({ portalUserId: `u${i}`, email: `p${i}@acme.test`, name: i === 0 ? 'Pat Doe' : null, status: 'active' as const })),
  total,
});

function renderDialog(props: Partial<Parameters<typeof SsoOnlyConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <SsoOnlyConfirmDialog
      open
      scope="org"
      impact={impact([{ orgId: ORG_A, orgName: 'Acme', passwordsToClear: 3, strandedTotal: 2 }])}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel };
}

describe('SsoOnlyConfirmDialog', () => {
  it('shows the counts and the stranded names for an org save', () => {
    renderDialog({ stranded: stranded(2) });
    const dialog = screen.getByTestId('sso-only-confirm-dialog');
    const row = within(dialog).getByTestId(`sso-only-confirm-flip-${ORG_A}`);
    expect(row).toHaveTextContent('3');
    expect(row).toHaveTextContent('2');
    const names = within(dialog).getByTestId('sso-only-confirm-stranded');
    expect(names).toHaveTextContent('Pat Doe');
    expect(names).toHaveTextContent('p1@acme.test');
  });

  it('caps the stranded names and says how many more', () => {
    renderDialog({ stranded: stranded(12, 40) });
    expect(screen.getByTestId('sso-only-confirm-stranded')).toHaveTextContent('and 30 more');
  });

  it('confirm passes the invite choice; the checkbox shows only with stranded accounts', () => {
    const { onConfirm } = renderDialog({ stranded: stranded(2) });
    fireEvent.click(screen.getByTestId('sso-only-confirm-send-invites'));
    fireEvent.click(screen.getByTestId('sso-only-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ sendInvites: true });
  });

  it('no invite checkbox when nothing is stranded', () => {
    renderDialog({ impact: impact([{ orgId: ORG_A, orgName: 'Acme', passwordsToClear: 3, strandedTotal: 0 }]), stranded: stranded(0) });
    expect(screen.queryByTestId('sso-only-confirm-send-invites')).toBeNull();
  });

  it('cancel calls onCancel and not onConfirm', () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('says when the impact changed since it was first shown', () => {
    renderDialog({ changed: true });
    expect(screen.getByTestId('sso-only-confirm-changed')).toHaveTextContent('The impact changed');
  });

  it('partner scope lists every affected org with a link and offers no invites', () => {
    renderDialog({
      scope: 'partner',
      impact: impact([
        { orgId: ORG_A, orgName: 'Acme', passwordsToClear: 3, strandedTotal: 2 },
        { orgId: ORG_B, orgName: 'Globex', passwordsToClear: 0, strandedTotal: 5 },
      ]),
    });
    const link = within(screen.getByTestId(`sso-only-confirm-flip-${ORG_B}`)).getByRole('link');
    expect(link).toHaveAttribute('href', `/settings/organizations/${ORG_B}#portal`);
    expect(screen.getByTestId(`sso-only-confirm-flip-${ORG_A}`)).toHaveTextContent('Acme');
    expect(screen.queryByTestId('sso-only-confirm-send-invites')).toBeNull();
    expect(screen.queryByTestId('sso-only-confirm-stranded')).toBeNull();
  });
});
