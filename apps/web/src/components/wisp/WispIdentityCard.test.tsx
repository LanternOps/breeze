import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { WispState } from '@/stores/aiStore';
import WispIdentityCard from './WispIdentityCard';

const mkWisp = (extra: Partial<NonNullable<WispState>> = {}): NonNullable<WispState> => ({
  grantId: 'g1', threadId: 't1', scopeOrgId: 'o1', focusOrgId: null, focusOrgName: null,
  status: 'active', expiresAt: new Date(Date.now() + 86400_000).toISOString(), summary: '',
  budgetCentsPerDay: 500, floorTickMinutes: 15, wideningAvailable: false, ...extra,
});

describe('WispIdentityCard', () => {
  it('shows the live line when checking', () => {
    render(<WispIdentityCard wisp={mkWisp()} orgName="Acme" currentActivity={{ orgId: 'o1', orgName: 'Greenwood', startedAt: new Date().toISOString() }} />);
    const line = screen.getByTestId('wisp-state-line');
    expect(line.getAttribute('aria-live')).toBe('polite');
    expect(line.textContent).toContain('Greenwood');
    expect(line.textContent?.toLowerCase()).toContain('checking');
    expect(line.querySelector('.animate-pulse')).not.toBeNull();
    expect(line.textContent).not.toContain('Active');
  });

  it('uses the unnamed checking copy when the org name is empty', () => {
    render(<WispIdentityCard wisp={mkWisp()} orgName={null} currentActivity={{ orgId: 'o1', orgName: '', startedAt: new Date().toISOString() }} />);
    expect(screen.getByTestId('wisp-state-line').textContent?.toLowerCase()).toContain('checking');
  });

  it('shows status dot, label and scope otherwise', () => {
    const { rerender } = render(<WispIdentityCard wisp={mkWisp()} orgName="Acme" currentActivity={null}><span data-testid="kid" /></WispIdentityCard>);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Wisp');
    let line = screen.getByTestId('wisp-state-line');
    expect(line.textContent).toContain('Acme');
    expect(line.textContent).toContain(' · ');
    expect(line.querySelector('.bg-emerald-500')).not.toBeNull();
    expect(screen.getByTestId('kid')).toBeTruthy();

    rerender(<WispIdentityCard wisp={mkWisp({ status: 'paused', scopeOrgId: null })} orgName={null} currentActivity={null} />);
    line = screen.getByTestId('wisp-state-line');
    expect(line.querySelector('.bg-amber-500')).not.toBeNull();
    expect(line.textContent).toContain('All organizations');
  });

  it('an active grant with the day budget spent reads Budget reached with the amber dot (as the thread header does)', () => {
    render(<WispIdentityCard wisp={mkWisp({ spentTodayCents: 500, budgetResetsAt: new Date(Date.now() + 3600_000).toISOString() })} orgName="Acme" currentActivity={null} />);
    const line = screen.getByTestId('wisp-state-line');
    expect(line.textContent).toContain('Budget reached');
    expect(line.querySelector('.bg-amber-500')).not.toBeNull();
    expect(line.querySelector('.bg-emerald-500')).toBeNull();
  });

  it('omits the separator when the scope label is empty', () => {
    render(<WispIdentityCard wisp={mkWisp({ status: 'revoked' })} orgName={null} currentActivity={null} />);
    const line = screen.getByTestId('wisp-state-line');
    expect(line.textContent).not.toContain('·');
    expect(line.querySelector('.bg-muted-foreground')).not.toBeNull();
  });
});
