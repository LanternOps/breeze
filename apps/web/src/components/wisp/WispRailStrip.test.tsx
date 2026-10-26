/**
 * W01 (#10211) Task 10: the strip that stands in for the rail below `lg`.
 * State line (or the live line), the needs-you count, and Details opening the
 * rail in the shared Drawer.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WispState } from '@/stores/aiStore';
import WispRailStrip from './WispRailStrip';

const mkWisp = (extra: Partial<NonNullable<WispState>> = {}): NonNullable<WispState> => ({
  grantId: 'g1', threadId: 't1', scopeOrgId: 'o1', focusOrgId: null, focusOrgName: null,
  status: 'active', expiresAt: new Date(Date.now() + 86400_000).toISOString(), summary: '',
  budgetCentsPerDay: 500, floorTickMinutes: 15, wideningAvailable: false, ...extra,
});

const rail = <div data-testid="rail-node">rail body</div>;

describe('WispRailStrip', () => {
  it('opens the drawer with the rail inside', () => {
    render(<WispRailStrip wisp={mkWisp()} current={null} needsYouCount={0} rail={rail} />);
    const strip = screen.getByTestId('wisp-rail-strip');
    expect(strip.className).toContain('lg:hidden');
    expect(screen.queryByTestId('wisp-rail-drawer')).toBeNull();
    expect(screen.queryByTestId('rail-node')).toBeNull();

    const details = screen.getByTestId('wisp-rail-details');
    expect(details.getAttribute('type')).toBe('button');
    expect(details.textContent).toContain('Details');
    fireEvent.click(details);

    const drawer = screen.getByTestId('wisp-rail-drawer');
    expect(within(drawer).getByRole('heading', { level: 2 }).textContent).toBe('Wisp');
    expect(within(drawer).getByTestId('rail-node')).toBeTruthy();

    fireEvent.click(screen.getByTestId('wisp-rail-drawer-close'));
    expect(screen.queryByTestId('wisp-rail-drawer')).toBeNull();
  });

  it('shows the needs-you count only when > 0', () => {
    const { rerender } = render(<WispRailStrip wisp={mkWisp()} current={null} needsYouCount={0} rail={rail} />);
    expect(screen.queryByTestId('wisp-rail-strip-needs-you')).toBeNull();
    rerender(<WispRailStrip wisp={mkWisp()} current={null} needsYouCount={3} rail={rail} />);
    expect(screen.getByTestId('wisp-rail-strip-needs-you').textContent).toBe('3 items');
    rerender(<WispRailStrip wisp={mkWisp()} current={null} needsYouCount={1} rail={rail} />);
    expect(screen.getByTestId('wisp-rail-strip-needs-you').textContent).toBe('1 item');
  });

  it('shows the live line when checking', () => {
    const { rerender } = render(<WispRailStrip wisp={mkWisp({ status: 'paused' })} current={null} needsYouCount={0} rail={rail} />);
    let line = screen.getByTestId('wisp-rail-strip-state');
    expect(line.textContent).toContain('Paused');
    expect(line.querySelector('.bg-amber-500')).not.toBeNull();

    rerender(
      <WispRailStrip
        wisp={mkWisp()}
        current={{ orgId: 'o1', orgName: 'Greenwood', startedAt: new Date().toISOString() }}
        needsYouCount={0}
        rail={rail}
      />,
    );
    line = screen.getByTestId('wisp-rail-strip-state');
    expect(line.getAttribute('aria-live')).toBe('polite');
    expect(line.textContent).toContain('Checking Greenwood');
    expect(line.textContent).not.toContain('Active');
    expect(line.querySelector('.animate-pulse')).not.toBeNull();

    rerender(
      <WispRailStrip wisp={mkWisp()} current={{ orgId: 'o1', orgName: '', startedAt: new Date().toISOString() }} needsYouCount={0} rail={rail} />,
    );
    expect(screen.getByTestId('wisp-rail-strip-state').textContent).toContain('Checking a customer');
  });

  describe('a deep link into the rail opens the drawer (the rail lives only in it below lg)', () => {
    afterEach(() => { window.history.replaceState(null, '', '/'); });

    it.each(['#concern=c-1', '#needs-you', '#links', '#activity'])('%s opens it on load', (hash) => {
      window.history.replaceState(null, '', `/ai/wisp/thread/t1${hash}`);
      render(<WispRailStrip wisp={mkWisp()} current={null} needsYouCount={0} rail={rail} />);
      expect(screen.getByTestId('wisp-rail-drawer')).toBeInTheDocument();
      expect(screen.getByTestId('rail-node')).toBeInTheDocument();
    });

    it('#thread does not, and a later hash change to a rail section does', () => {
      window.history.replaceState(null, '', '/wisp#thread');
      render(<WispRailStrip wisp={mkWisp()} current={null} needsYouCount={0} rail={rail} />);
      expect(screen.queryByTestId('wisp-rail-drawer')).toBeNull();
      act(() => {
        window.history.replaceState(null, '', '/wisp#concern=c-2');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      expect(screen.getByTestId('wisp-rail-drawer')).toBeInTheDocument();
    });
  });
});
