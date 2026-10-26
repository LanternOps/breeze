import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import WispBriefPost from './WispBriefPost';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

describe('WispBriefPost', () => {
  it('renders sections with headings and lines in order', () => {
    render(
      <WispBriefPost
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
    const { unmount } = render(<WispBriefPost brief={{ sentAt: hoursAgo(30), sections }} now={NOW} />);
    expect(screen.getByTestId('wisp-brief-stale').textContent).toBe('From an earlier day');
    unmount();
    render(<WispBriefPost brief={{ sentAt: hoursAgo(2), sections }} now={NOW} />);
    expect(screen.queryByTestId('wisp-brief-stale')).toBeNull();
  });

  it('showStale={false} hides the badge on a 30-hour-old brief', () => {
    render(
      <WispBriefPost
        brief={{ sentAt: hoursAgo(30), sections: [{ heading: 'H', lines: ['l'] }] }}
        now={NOW}
        showStale={false}
      />,
    );
    expect(screen.queryByTestId('wisp-brief-stale')).toBeNull();
  });

  it('renders the unread dot first in the eyebrow only when unread', () => {
    const sections = [{ heading: 'H', lines: ['l'] }];
    const { unmount } = render(<WispBriefPost brief={{ sentAt: hoursAgo(1), sections }} now={NOW} unread />);
    const dot = screen.getByTestId('wisp-post-unread');
    expect(dot.parentElement?.tagName).toBe('P');
    expect(dot.parentElement?.firstElementChild).toBe(dot);
    unmount();
    render(<WispBriefPost brief={{ sentAt: hoursAgo(1), sections }} now={NOW} />);
    expect(screen.queryByTestId('wisp-post-unread')).toBeNull();
  });

  it('renders markup in a line as literal text', () => {
    render(<WispBriefPost brief={{ sentAt: hoursAgo(1), sections: [{ heading: 'H', lines: ['<b>x</b>'] }] }} now={NOW} />);
    const li = screen.getByText('<b>x</b>');
    expect(li.querySelector('b')).toBeNull();
  });

  it('renders the Morning brief eyebrow and no card border', () => {
    render(<WispBriefPost brief={{ sentAt: hoursAgo(1), sections: [{ heading: 'H', lines: ['l'] }] }} now={NOW} />);
    const root = screen.getByTestId('wisp-brief-card');
    expect(root.tagName).toBe('ARTICLE');
    expect(root.className).not.toMatch(/\bborder\b/);
    expect(root.className).not.toMatch(/\bbg-card\b/);
    expect(screen.getByText('Morning brief')).toBeTruthy();
  });
});
