import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import WispBriefCard from './WispBriefCard';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

describe('WispBriefCard', () => {
  it('renders the empty line for a null brief', () => {
    render(<WispBriefCard brief={null} now={NOW} />);
    expect(screen.getByTestId('wisp-brief-empty')).toBeTruthy();
    expect(screen.queryByTestId('wisp-brief-sent')).toBeNull();
  });

  it('renders the empty line when there are no sections', () => {
    render(<WispBriefCard brief={{ sentAt: hoursAgo(1), sections: [] }} now={NOW} />);
    expect(screen.getByTestId('wisp-brief-empty')).toBeTruthy();
  });

  it('renders sections with headings and lines in order', () => {
    render(
      <WispBriefCard
        brief={{
          sentAt: hoursAgo(2),
          sections: [
            { heading: 'Overnight', lines: ['first line', 'second line'] },
            { heading: 'Today', lines: ['third line'] },
          ],
        }}
        now={NOW}
      />,
    );
    const sections = screen.getAllByTestId('wisp-brief-section');
    expect(sections).toHaveLength(2);
    expect(sections[0].querySelector('h3')?.textContent).toBe('Overnight');
    expect(Array.from(sections[0].querySelectorAll('li')).map((l) => l.textContent)).toEqual(['first line', 'second line']);
    expect(sections[1].querySelector('h3')?.textContent).toBe('Today');
    expect(screen.getByTestId('wisp-brief-sent').textContent).toMatch(/^Sent /);
  });

  it('shows the stale badge for a 30-hour-old brief only', () => {
    const sections = [{ heading: 'H', lines: ['l'] }];
    const { unmount } = render(<WispBriefCard brief={{ sentAt: hoursAgo(30), sections }} now={NOW} />);
    expect(screen.getByTestId('wisp-brief-stale').textContent).toBe('From an earlier day');
    unmount();
    render(<WispBriefCard brief={{ sentAt: hoursAgo(2), sections }} now={NOW} />);
    expect(screen.queryByTestId('wisp-brief-stale')).toBeNull();
  });

  it('renders markup in a line as literal text', () => {
    render(<WispBriefCard brief={{ sentAt: hoursAgo(1), sections: [{ heading: 'H', lines: ['<b>x</b>'] }] }} now={NOW} />);
    const li = screen.getByText('<b>x</b>');
    expect(li.querySelector('b')).toBeNull();
  });
});
