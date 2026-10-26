/**
 * W01 (#10211) Task 10: the Wisp rail. Sections in order (identity with the
 * grant controls, needs you, workers, linked items, activity, footer links),
 * the hash-target ids, and the props each child receives. Heavy children are
 * stubs that record their props.
 */
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Concern, WispThreadLink } from '@breeze/shared';
import type { WispState } from '@/stores/aiStore';
import WispRail, { type WispRailProps } from './WispRail';

const h = vi.hoisted(() => ({
  headerProps: null as null | Record<string, unknown>,
  needsYouProps: null as null | Record<string, unknown>,
  workersProps: null as null | Record<string, unknown>,
  linksProps: null as null | Record<string, unknown>,
  activityProps: null as null | Record<string, unknown>,
}));

vi.mock('../ai/WispThreadHeader', () => ({
  default: (props: Record<string, unknown>) => {
    h.headerProps = props;
    return <div data-testid="wisp-thread-header" />;
  },
}));
// The real component owns `id="needs-you"`; the stub carries it the same way.
vi.mock('./WispNeedsYou', () => ({
  default: (props: Record<string, unknown>) => {
    h.needsYouProps = props;
    return <section id="needs-you" data-testid="wisp-needs-you" />;
  },
}));
vi.mock('./WispWorkersPanel', () => ({
  default: (props: Record<string, unknown>) => {
    h.workersProps = props;
    return <section data-testid="wisp-workers" />;
  },
}));
// The real component owns `id="links"`; the stub carries it the same way.
vi.mock('./WispLinksPanel', () => ({
  default: (props: Record<string, unknown>) => {
    h.linksProps = props;
    return <section id="links" data-testid="wisp-links-panel" />;
  },
}));
vi.mock('./WispActivityPanel', () => ({
  default: (props: Record<string, unknown>) => {
    h.activityProps = props;
    return <div data-testid="wisp-activity" />;
  },
}));

const mkWisp = (extra: Partial<NonNullable<WispState>> = {}): NonNullable<WispState> => ({
  grantId: 'g1', threadId: 't1', scopeOrgId: 'o1', focusOrgId: null, focusOrgName: null,
  status: 'active', expiresAt: new Date(Date.now() + 86400_000).toISOString(), summary: '',
  budgetCentsPerDay: 500, floorTickMinutes: 15, wideningAvailable: true, ...extra,
});

const concern = { id: 'c1', status: 'open' } as unknown as Concern;
const link = { id: 'l1' } as unknown as WispThreadLink;

const mkProps = (extra: Partial<WispRailProps> = {}): WispRailProps => ({
  wisp: mkWisp(),
  orgName: 'Acme',
  current: null,
  needsYou: [concern],
  links: [link],
  onLinksChange: vi.fn(),
  onWispChange: vi.fn(),
  onRevoked: vi.fn(),
  activityKey: 3,
  ...extra,
});

const ORDER = ['wisp-identity', 'wisp-needs-you', 'wisp-workers', 'wisp-links-panel', 'wisp-activity', 'wisp-rail-nav'];

describe('WispRail', () => {
  beforeEach(() => {
    h.headerProps = null;
    h.needsYouProps = null;
    h.workersProps = null;
    h.linksProps = null;
    h.activityProps = null;
  });

  it('renders sections in order with their ids and the footer links', () => {
    const props = mkProps({ current: { orgId: 'o1', orgName: 'Greenwood', startedAt: new Date().toISOString() } });
    const { container } = render(<WispRail {...props} />);
    const rail = screen.getByTestId('wisp-rail');

    const seen = Array.from(rail.querySelectorAll('[data-testid]'))
      .map((el) => el.getAttribute('data-testid'))
      .filter((id): id is string => ORDER.includes(id ?? ''));
    expect(seen).toEqual(ORDER);

    // Hash deep links land on the rail sections, each exactly once.
    for (const id of ['needs-you', 'links', 'activity']) {
      expect(container.querySelectorAll(`#${id}`)).toHaveLength(1);
    }
    expect(within(container.querySelector('#activity') as HTMLElement).getByTestId('wisp-activity')).toBeTruthy();

    // The grant controls sit inside the identity card; the live line is the card's, not the header's.
    const identity = screen.getByTestId('wisp-identity');
    expect(within(identity).getByTestId('wisp-thread-header')).toBeTruthy();
    expect(screen.getByTestId('wisp-state-line').textContent).toContain('Greenwood');
    expect(h.headerProps).toMatchObject({
      wisp: props.wisp, orgName: 'Acme', wideningAvailable: true, showFocus: false, currentActivity: null,
      onWispChange: props.onWispChange, onRevoked: props.onRevoked,
    });

    expect(h.needsYouProps).toMatchObject({ grantId: 'g1', threadId: 't1', initial: [concern] });
    expect(h.workersProps).toMatchObject({ threadId: 't1', refreshKey: 3 });
    expect(h.linksProps).toMatchObject({ threadId: 't1', links: [link], onLinksChange: props.onLinksChange });
    expect(h.activityProps).toMatchObject({ threadId: 't1', refreshKey: 3, collapsible: true });

    const chats = screen.getByTestId('wisp-home-chats');
    expect(chats.getAttribute('href')).toBe('/ai/chat');
    expect(chats.textContent).toContain('All chats');
    const memory = screen.getByTestId('wisp-home-memory');
    expect(memory.getAttribute('href')).toBe('/settings/wisp-memory');
    expect(memory.textContent).toContain('Memory');
    expect(screen.getByTestId('wisp-rail-nav').tagName).toBe('NAV');
  });

  it('needsYou null hides the section', () => {
    const { container } = render(<WispRail {...mkProps({ needsYou: null })} />);
    expect(screen.queryByTestId('wisp-needs-you')).toBeNull();
    expect(h.needsYouProps).toBeNull();
    expect(container.querySelector('#needs-you')).toBeNull();
    expect(screen.getByTestId('wisp-workers')).toBeTruthy();
  });

  it('links null hides the section', () => {
    const { container } = render(<WispRail {...mkProps({ links: null })} />);
    expect(screen.queryByTestId('wisp-links-panel')).toBeNull();
    expect(h.linksProps).toBeNull();
    expect(container.querySelector('#links')).toBeNull();
    expect(screen.getByTestId('wisp-activity')).toBeTruthy();
  });

  it('links panel canAdd follows the grant status', () => {
    const { rerender } = render(<WispRail {...mkProps()} />);
    expect(h.linksProps?.canAdd).toBe(true);
    rerender(<WispRail {...mkProps({ wisp: mkWisp({ status: 'paused' }) })} />);
    expect(h.linksProps?.canAdd).toBe(false);
  });
});
