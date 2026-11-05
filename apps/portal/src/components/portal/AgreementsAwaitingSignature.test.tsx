// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PortalAgreementSummary } from '@/lib/api';

import { AgreementsAwaitingSignature } from './AgreementsAwaitingSignature';

afterEach(cleanup);

const row = (id: string, canSign: boolean): PortalAgreementSummary => ({
  id, name: `Agreement ${id}`, templateName: null, status: 'sent', sentAt: null,
  expiresAt: '2026-12-01T00:00:00.000Z', canSign,
});

describe('AgreementsAwaitingSignature', () => {
  it('renders nothing for an empty list', () => {
    const { container } = render(<AgreementsAwaitingSignature timezone="UTC" agreements={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when no row is signable by this user', () => {
    const { container } = render(<AgreementsAwaitingSignature timezone="UTC" agreements={[row('a', false)]} />);
    expect(container.innerHTML).toBe('');
  });

  it('lists only the signable rows, linked, with a view-all link', () => {
    render(<AgreementsAwaitingSignature timezone="UTC" agreements={[row('a', true), row('b', false), row('c', true)]} />);
    const card = screen.getByTestId('dashboard-agreements-awaiting');
    expect(card.textContent).toContain('Awaiting your signature');
    expect(screen.getByTestId('dashboard-agreements-awaiting-row-a').getAttribute('href')).toContain('/agreements/a');
    expect(screen.getByTestId('dashboard-agreements-awaiting-row-a').textContent).toContain('Agreement a');
    expect(screen.queryByTestId('dashboard-agreements-awaiting-row-b')).toBeNull();
    expect(screen.getByTestId('dashboard-agreements-awaiting-row-c')).toBeTruthy();
    const all = screen.getByTestId('dashboard-agreements-awaiting-all');
    expect(all.textContent).toContain('View all agreements');
    expect(all.getAttribute('href')).toMatch(/\/agreements$/);
  });

  // #10291: SSR (UTC container) printed 11/10 for an expiry at the end of 9 Nov
  // Denver while the hydrated detail printed November 9. The card formats in
  // the org zone it is handed, so both agree whatever the runtime zone.
  it('shows the expiry as the calendar day in the org zone', () => {
    render(
      <AgreementsAwaitingSignature
        agreements={[{ ...row('a', true), expiresAt: '2026-11-10T06:59:59.999Z' }]}
        timezone="America/Denver"
      />,
    );
    expect(screen.getByTestId('dashboard-agreements-awaiting-row-a').textContent)
      .toContain(`Expires ${new Date(2026, 10, 9).toLocaleDateString()}`);
  });
});
