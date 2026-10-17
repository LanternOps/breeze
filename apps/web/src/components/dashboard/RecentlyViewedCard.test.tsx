import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecentlyViewedCard from './RecentlyViewedCard';
import type { RecentEntry, RecentEntryKind } from '../../stores/recentsStore';
import { i18n } from '../../lib/i18n';

const NOW = new Date('2026-10-16T12:00:00Z').getTime();
const entry = (kind: RecentEntryKind, href: string, label: string, agoMs: number): RecentEntry => ({
  kind,
  href,
  label,
  at: NOW - agoMs,
});

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RecentlyViewedCard', () => {
  it('renders nothing when there are no entries', () => {
    expect(render(<RecentlyViewedCard entries={[]} />).container.firstChild).toBeNull();
  });

  it('lists each entry as a link with icon, kind label and relative time', () => {
    render(
      <RecentlyViewedCard
        entries={[
          entry('org', '/organizations/o1', 'Acme Dental', 2 * 3_600_000),
          entry('device', '/devices/d1', 'LAPTOP-01', 30_000),
          entry('ticket', '/tickets/t1', 'T-0042', 86_400_000),
        ]}
      />,
    );
    expect(screen.getByTestId('dashboard-recently-viewed-heading')).toHaveTextContent('Pick up where you left off');
    const links = screen.getAllByTestId('dashboard-recently-viewed-link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/organizations/o1', '/devices/d1', '/tickets/t1']);
    expect(links[0]).toHaveTextContent('Acme Dental');
    expect(links[0]).toHaveTextContent('Organization');
    expect(links[0]).toHaveTextContent('2 hours ago');
    expect(links[1]).toHaveTextContent('Device');
    expect(links[2]).toHaveTextContent('Ticket');
    expect(links[2]).toHaveTextContent('yesterday');
    expect(links[0].querySelector('svg.lucide-building-2')).not.toBeNull();
    expect(links[1].querySelector('svg.lucide-monitor')).not.toBeNull();
  });

  it('does not throw for an entry stamped in the future', () => {
    render(<RecentlyViewedCard entries={[entry('page', '/scripts/x', 'Reboot', -3_600_000)]} />);
    expect(screen.getAllByTestId('dashboard-recently-viewed-link')).toHaveLength(1);
  });

  it('truncates long labels and keeps the full name in title', () => {
    const long = 'y'.repeat(200);
    render(<RecentlyViewedCard entries={[entry('device', '/devices/d1', long, 1000)]} />);
    const link = screen.getByTestId('dashboard-recently-viewed-link');
    expect(link).toHaveAttribute('title', long);
    expect(screen.getByText(long).className).toContain('truncate');
  });
});
