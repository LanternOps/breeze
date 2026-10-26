import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { WispTimelinePost } from '@breeze/shared';
import WispPost from './WispPost';

const base: WispTimelinePost = {
  source: 'post',
  id: 'p-1',
  kind: 'nudge',
  title: 'Disk almost full on FS-01',
  body: 'C: is at 96%.',
  link: '/ai/wisp/thread/th-1#concern=c-1',
  sections: null,
  concernId: 'c-1',
  orgId: 'o-1',
  read: null,
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
};

const post = (over: Partial<WispTimelinePost>): WispTimelinePost => ({ ...base, ...over });
const sections = [{ heading: 'Overnight', lines: ['all quiet'] }];

describe('WispPost', () => {
  it('renders a brief with sections through the brief card, never stale', () => {
    const old = new Date(Date.now() - 30 * 3600_000).toISOString();
    render(<WispPost post={post({ kind: 'brief', sections, createdAt: old })} />);
    const root = screen.getByTestId('wisp-post');
    expect(root.getAttribute('data-kind')).toBe('brief');
    expect(root.querySelector('[data-testid="wisp-brief-card"]')).not.toBeNull();
    expect(screen.getAllByTestId('wisp-brief-section')).toHaveLength(1);
    expect(screen.queryByTestId('wisp-brief-stale')).toBeNull();
  });

  it('falls back to a plain post for a brief with null sections', () => {
    render(<WispPost post={post({ kind: 'brief', sections: null, title: 'Brief T', body: 'Brief B' })} />);
    expect(screen.queryByTestId('wisp-brief-card')).toBeNull();
    expect(screen.getByText('Morning brief')).toBeTruthy();
    expect(screen.getByTestId('wisp-post-title').textContent).toBe('Brief T');
    expect(screen.getByTestId('wisp-post-body').textContent).toBe('Brief B');
  });

  it('falls back to a plain post for a brief with empty sections', () => {
    render(<WispPost post={post({ kind: 'brief', sections: [] })} />);
    expect(screen.queryByTestId('wisp-brief-card')).toBeNull();
    expect(screen.getByTestId('wisp-post').tagName).toBe('ARTICLE');
  });

  it('renders a nudge with eyebrow, title, body and relative link', () => {
    render(<WispPost post={post({})} />);
    const root = screen.getByTestId('wisp-post');
    expect(root.getAttribute('data-kind')).toBe('nudge');
    expect(root.className).not.toMatch(/\bborder\b/);
    expect(root.className).not.toMatch(/\bbg-card\b/);
    expect(screen.getByText('Nudge')).toBeTruthy();
    expect(screen.getByTestId('wisp-post-sent').textContent).toMatch(/^Sent /);
    expect(screen.getByTestId('wisp-post-title').textContent).toBe('Disk almost full on FS-01');
    expect(screen.getByTestId('wisp-post-body').textContent).toBe('C: is at 96%.');
    const open = screen.getByTestId('wisp-post-open');
    expect(open.getAttribute('href')).toBe('/ai/wisp/thread/th-1#concern=c-1');
    expect(open.textContent).toBe('Open');
  });

  it('renders a digest', () => {
    render(<WispPost post={post({ kind: 'digest', title: 'Weekly digest' })} />);
    expect(screen.getByTestId('wisp-post').getAttribute('data-kind')).toBe('digest');
    expect(screen.getByText('Digest')).toBeTruthy();
    expect(screen.getByTestId('wisp-post-title').textContent).toBe('Weekly digest');
    expect(screen.getByTestId('wisp-post-body')).toBeTruthy();
    expect(screen.getByTestId('wisp-post-open')).toBeTruthy();
  });

  it.each(['https://evil.example/x', '//evil', 'javascript:alert(1)', null])(
    'renders no link for unsafe link %s',
    (link) => {
      render(<WispPost post={post({ link })} />);
      expect(screen.queryByTestId('wisp-post-open')).toBeNull();
      expect(document.querySelector('a')).toBeNull();
    },
  );

  it('shows the unread dot only when read is false', () => {
    const { unmount } = render(<WispPost post={post({ read: false })} />);
    expect(screen.getByTestId('wisp-post-unread').getAttribute('aria-label')).toBe('Unread');
    expect(screen.getByRole('img', { name: 'Unread' })).toBeTruthy();
    unmount();
    for (const read of [true, null]) {
      const r = render(<WispPost post={post({ read })} />);
      expect(screen.queryByTestId('wisp-post-unread')).toBeNull();
      r.unmount();
    }
  });

  it('shows the unread dot on a brief with sections', () => {
    const { unmount } = render(<WispPost post={post({ kind: 'brief', sections, read: false })} />);
    expect(screen.getByTestId('wisp-post-unread')).toBeTruthy();
    unmount();
    for (const read of [true, null]) {
      const r = render(<WispPost post={post({ kind: 'brief', sections, read })} />);
      expect(screen.queryByTestId('wisp-post-unread')).toBeNull();
      r.unmount();
    }
  });

  it('renders markup in title and body as literal text', () => {
    render(<WispPost post={post({ title: '<b>x</b>', body: '<i>y</i>' })} />);
    const title = screen.getByTestId('wisp-post-title');
    expect(title.textContent).toBe('<b>x</b>');
    expect(title.querySelector('b')).toBeNull();
    expect(screen.getByTestId('wisp-post-body').querySelector('i')).toBeNull();
  });

  it.each([null, ''])('renders no body element for body %j', (body) => {
    render(<WispPost post={post({ body })} />);
    expect(screen.queryByTestId('wisp-post-body')).toBeNull();
  });
});
