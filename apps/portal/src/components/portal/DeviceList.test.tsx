// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrichedPortalDevice } from '@breeze/shared';

// Resolving the full API module pulls in Astro's virtual transitions module,
// which is unavailable under Vitest. Keep the browser-facing path contract
// represented directly in this component test.
vi.mock('@/lib/api', () => ({
  publicApiPath: (path: string) => `/api/v1${path}`,
}));

import { DeviceList } from './DeviceList';

// The API hands the portal a formatted stamp in the org's timezone
// (services/portal/deviceReadModel.ts), not an ISO instant — these fixtures
// are the real shape.
const laptop: EnrichedPortalDevice = {
  id: 'd-1',
  hostname: 'laptop-01',
  displayName: 'Front desk laptop',
  osType: 'macos',
  osVersion: '15.1',
  status: 'online',
  lastSeenAt: 'Sep 3, 2026, 11:55 AM UTC',
  lastPatchAt: 'Aug 31, 2026, 6:00 PM UTC',
  protection: 'protected',
  encryption: 'encrypted',
  lastBackupAt: 'Sep 2, 2026, 2:00 AM UTC',
  warrantyEndsAt: '2027-01-01',
};

const server: EnrichedPortalDevice = {
  id: 'd-2',
  hostname: 'server-01',
  displayName: null,
  osType: 'windows',
  osVersion: '11',
  status: 'offline',
  lastSeenAt: null,
  lastPatchAt: null,
  protection: 'unprotected',
  encryption: 'unencrypted',
  lastBackupAt: null,
  warrantyEndsAt: null,
};

afterEach(() => vi.useRealTimers());

describe('DeviceList', () => {
  it('keeps five visible columns and never clips the ledger behind a scroll', () => {
    render(<DeviceList devices={[laptop]} />);

    const table = screen.getByTestId('portal-device-table');
    expect(
      Array.from(table.querySelectorAll('th')).map((th) => th.textContent?.trim())
    ).toEqual(['Device', 'Type', 'Status', 'Last online', 'Protection']);
    // A min-width wider than the 64rem content column is what hid "Warranty
    // ends" behind a horizontal scroll with no affordance.
    expect(table.className).not.toMatch(/min-w-/);
  });

  it('says when a device was last online in words, keeping the exact stamp on hover', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-09-03T12:00:00Z'));
    render(<DeviceList devices={[laptop, server]} />);

    const row = screen.getByTestId('portal-device-d-1');
    const online = within(row).getByTestId('portal-device-d-1-last-online');
    expect(online.textContent).toContain('5 minutes ago');
    expect(online.textContent).not.toContain('11:55 AM');
    expect(online.getAttribute('title')).toBe('Sep 3, 2026, 11:55 AM UTC');

    expect(
      within(screen.getByTestId('portal-device-d-2')).getByTestId(
        'portal-device-d-2-last-online'
      ).textContent
    ).toContain('Not known');
  });

  it('speaks the reader’s words for the platform', () => {
    render(<DeviceList devices={[laptop, server]} />);

    expect(screen.getByTestId('portal-device-d-1').textContent).toContain('Mac');
    expect(screen.getByTestId('portal-device-d-1').textContent).not.toContain('macos');
    expect(screen.getByTestId('portal-device-d-2').textContent).toContain('Windows');
    expect(screen.getByTestId('portal-device-d-2').textContent).toContain('Not protected');
  });

  it('demotes the technician facts into a per-row disclosure', () => {
    render(<DeviceList devices={[laptop]} />);

    // Every demoted fact lives inside the disclosure, never loose in the row.
    const more = screen.getByTestId('portal-device-d-1-more');
    for (const demoted of ['Last patch', 'Encryption', 'Last backup', 'Warranty ends']) {
      expect(screen.getByText(demoted).closest('details')).toBe(more);
    }

    expect(more.tagName).toBe('DETAILS');
    expect(within(more).getByText('More about this device')).toBeTruthy();
    expect(more.textContent).toContain('Last patch');
    expect(more.textContent).toContain('Encryption');
    expect(more.textContent).toContain('Encrypted');
    expect(more.textContent).toContain('Last backup');
    expect(more.textContent).toContain('Warranty ends');
    // A warranty end is a future date: it is never relative time.
    expect(more.textContent).toContain('Jan 1, 2027');
  });

  it('reflows every card the same way on a phone', () => {
    render(<DeviceList devices={[laptop, server]} />);

    const signature = (id: string) =>
      Array.from(screen.getByTestId(id).querySelectorAll('td')).map(
        (cell) => cell.className.match(/order-\d+/)?.[0]
      );

    expect(signature('portal-device-d-1')).toEqual([
      'order-1',
      'order-3',
      'order-2',
      'order-4',
      'order-5',
    ]);
    expect(signature('portal-device-d-2')).toEqual(signature('portal-device-d-1'));
  });

  it('carries one status mark per row and the register foot line', () => {
    render(<DeviceList devices={[laptop, server]} />);

    expect(
      screen.getByTestId('portal-device-d-1').querySelectorAll('[aria-hidden="true"].rounded-full')
    ).toHaveLength(1);
    expect(screen.getByTestId('device-ledger-foot').textContent).toBe('1 of 2 online');
  });

  it('totals an all-online fleet in the foot line and exports same-origin', () => {
    render(<DeviceList devices={[laptop]} />);

    expect(screen.getByTestId('device-ledger-foot').textContent).toBe('Your device is online');
    expect(screen.getByTestId('portal-devices-export').getAttribute('href')).toBe(
      '/api/v1/portal/devices/export.csv'
    );
  });

  it('reads label over value on a phone card, not one muted run-on', () => {
    render(<DeviceList devices={[laptop]} />);

    const labels = Array.from(
      screen.getByTestId('portal-device-d-1').querySelectorAll('.sm\\:hidden')
    );
    expect(labels.map((el) => el.textContent)).toEqual([
      'Type',
      'Last online',
      'Protection',
    ]);
    for (const label of labels) {
      // The Label style: 12px semibold small-caps in quiet ink, on its own line
      // above the value (apps/portal/DESIGN.md, Typography → Label).
      expect(label.className).toContain('block');
      expect(label.className).toContain('text-xs');
      expect(label.className).toContain('font-semibold');
      expect(label.className).toContain('uppercase');
      expect(label.className).toContain('tracking-[0.08em]');
      expect(label.className).toContain('text-muted-foreground');
    }
  });

  it('says what the customer should do instead of printing the backend error', () => {
    render(<DeviceList devices={[]} error="ECONNREFUSED 10.0.0.4:5432" />);

    const notice = screen.getByRole('alert');
    expect(notice.textContent).toBe(
      "We couldn't load your devices just now. Your IT team can help."
    );
    expect(notice.textContent).not.toContain('ECONNREFUSED');
  });

  it('titles its empty state one level under the page title', () => {
    render(<DeviceList devices={[]} />);
    expect(screen.getByRole('heading', { name: 'No devices' }).tagName).toBe('H2');
  });

  describe('SSR/hydration stability for relative-time cells (#5881)', () => {
    // `formatRelativeTime` reads the clock during render. SSR reads it once
    // (Node's process clock); the client's first render reads it again
    // (the browser's clock) before hydration ever commits. If either read
    // lands on a different calendar day — a real timezone difference, or
    // simply the gap between the two calls crossing local midnight —
    // `calendarDaysAgo`'s LOCAL-timezone day getters put the two renders in
    // different day buckets and React discards the SSR tree. The boundary is
    // computed from the test runner's own local midnight (not a hardcoded UTC
    // instant) so this reproduces on any CI runner's timezone, not just one
    // that happens to differ from UTC.
    it('renders byte-identical HTML for a "server" render and a "client" render taken on opposite sides of a local day boundary', () => {
      const now = new Date();
      const nextLocalMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const beforeMidnight = new Date(nextLocalMidnight.getTime() - 1000); // 23:59:59 local
      const afterMidnight = new Date(nextLocalMidnight.getTime() + 5000); // 00:00:05 local
      // 12h before the boundary: well inside "today" at T1, but crosses into
      // "yesterday" once the clock reads T2, the SSR-"Yesterday" vs
      // client-"N hours ago" split from the issue repro.
      const lastSeenAt = new Date(beforeMidnight.getTime() - 12 * 60 * 60 * 1000).toISOString();
      const device = { ...laptop, lastSeenAt };

      vi.useFakeTimers().setSystemTime(beforeMidnight);
      const serverHtml = renderToString(<DeviceList devices={[device, server]} />);

      vi.setSystemTime(afterMidnight);
      const clientFirstRenderHtml = renderToString(<DeviceList devices={[device, server]} />);

      expect(clientFirstRenderHtml).toBe(serverHtml);
    });

    it('shows the raw stamp (not a relative phrase) before mount, then swaps to relative time after mount', () => {
      vi.useFakeTimers().setSystemTime(new Date('2026-09-03T12:00:00Z'));

      const container = document.createElement('div');
      container.innerHTML = renderToString(<DeviceList devices={[laptop]} />);
      const preMount = container.querySelector('[data-testid="portal-device-d-1-last-online"]');
      // The phone-only "Last online" label span shares this cell; assert on
      // the trailing value text, not the whole cell.
      expect(preMount?.textContent).toBe('Last onlineSep 3, 2026, 11:55 AM UTC');
      expect(preMount?.textContent).not.toContain('ago');

      render(<DeviceList devices={[laptop]} />);
      const postMount = screen.getByTestId('portal-device-d-1-last-online');
      expect(postMount.textContent).toContain('5 minutes ago');
    });

    // `moreFacts` (the per-row disclosure) threads `mounted` independently
    // from the "Last online" cell above — a regression there (e.g. a stale
    // `mounted` capture) wouldn't be caught by the "Last online" assertions.
    it('swaps Last patch / Last backup to relative time after mount too, not just Last online', () => {
      vi.useFakeTimers().setSystemTime(new Date('2026-09-03T12:00:00Z'));
      // Minutes-scale gaps so the expected text is a plain elapsed-time count
      // (TZ-independent — no calendar-day bucketing involved either way).
      const device: EnrichedPortalDevice = {
        ...laptop,
        lastPatchAt: 'Sep 3, 2026, 11:50 AM UTC',
        lastBackupAt: 'Sep 3, 2026, 11:57 AM UTC',
      };

      const container = document.createElement('div');
      container.innerHTML = renderToString(<DeviceList devices={[device]} />);
      const preMount = container.querySelector('[data-testid="portal-device-d-1-more"]');
      expect(preMount?.textContent).toContain('Sep 3, 2026, 11:50 AM UTC');
      expect(preMount?.textContent).toContain('Sep 3, 2026, 11:57 AM UTC');
      expect(preMount?.textContent).not.toContain('minutes ago');

      render(<DeviceList devices={[device]} />);
      const postMount = screen.getByTestId('portal-device-d-1-more');
      expect(postMount.textContent).toContain('10 minutes ago');
      expect(postMount.textContent).toContain('3 minutes ago');
    });
  });

  describe('scroll-and-highlight from a #<deviceId> hash', () => {
    const scrollIntoView = vi.fn();

    beforeEach(() => {
      scrollIntoView.mockClear();
      Element.prototype.scrollIntoView = scrollIntoView;
    });

    afterEach(() => {
      window.location.hash = '';
    });

    it('highlights and scrolls to the row matching the hash on mount', () => {
      window.location.hash = '#d-1';
      render(<DeviceList devices={[laptop, server]} />);

      const row = screen.getByTestId('portal-device-d-1');
      expect(row.className).toContain('ring-2');
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
      expect(screen.getByTestId('portal-device-d-2').className).not.toContain('ring-2');
    });

    it('highlights nothing and never throws when there is no hash', () => {
      window.location.hash = '';
      expect(() => render(<DeviceList devices={[laptop, server]} />)).not.toThrow();
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(screen.getByTestId('portal-device-d-1').className).not.toContain('ring-2');
    });

    it('highlights nothing when the hash matches no device', () => {
      window.location.hash = '#does-not-exist';
      render(<DeviceList devices={[laptop, server]} />);

      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(screen.getByTestId('portal-device-d-1').className).not.toContain('ring-2');
      expect(screen.getByTestId('portal-device-d-2').className).not.toContain('ring-2');
    });

    it('clears the highlight after the timeout', () => {
      vi.useFakeTimers();
      window.location.hash = '#d-1';
      render(<DeviceList devices={[laptop, server]} />);

      expect(screen.getByTestId('portal-device-d-1').className).toContain('ring-2');
      act(() => {
        vi.runAllTimers();
      });
      expect(screen.getByTestId('portal-device-d-1').className).not.toContain('ring-2');
    });
  });
});
