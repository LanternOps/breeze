import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

  it('renders a check_in post with the Check-in eyebrow and no Open link', () => {
    render(
      <WispPost
        post={post({
          kind: 'check_in',
          title: 'Check-in due: Verify no msiexec processes remain',
          body: 'Verify no msiexec processes remain on FS-01.',
          link: '/ai/wisp/thread/th-1#checkin=ci-1',
          concernId: null,
        })}
      />,
    );
    const root = screen.getByTestId('wisp-post');
    expect(root.getAttribute('data-kind')).toBe('check_in');
    expect(screen.getByText('Check-in')).toBeTruthy();
    expect(screen.getByTestId('wisp-post-title').textContent).toBe('Check-in due: Verify no msiexec processes remain');
    expect(screen.getByTestId('wisp-post-body').textContent).toBe('Verify no msiexec processes remain on FS-01.');
    // The link points at this same thread; an "Open" link would be a no-op.
    expect(screen.queryByTestId('wisp-post-open')).toBeNull();
  });

  it("a couldn't-look post has its own eyebrow, and never reads as a first look (#11145)", () => {
    render(<WispPost post={post({ kind: 'first_look', variant: 'couldnt_look', title: "I couldn't look yet: 0 of 2 organizations", body: 'Why.', link: '/ai/wisp/thread/th-1', concernId: null })} />);
    const el = screen.getByTestId('wisp-post');
    expect(el.getAttribute('data-kind')).toBe('first_look');
    expect(el.getAttribute('data-variant')).toBe('couldnt_look');
    expect(screen.getByText("Couldn't look yet")).toBeTruthy();
    expect(screen.queryByText('First look')).toBeNull();
    expect(screen.queryByTestId('wisp-post-open')).toBeNull();
  });

  it('renders a first_look post with the First look eyebrow and no Open link (#10402)', () => {
    render(<WispPost post={post({ kind: 'first_look', title: 'First look done: 2 of 2 organizations', body: 'Open concerns: 1 high.', link: '/ai/wisp/thread/th-1', concernId: null })} />);
    expect(screen.getByTestId('wisp-post').getAttribute('data-kind')).toBe('first_look');
    expect(screen.getByText('First look')).toBeTruthy();
    expect(screen.getByTestId('wisp-post-title').textContent).toBe('First look done: 2 of 2 organizations');
    expect(screen.getByTestId('wisp-post-body').textContent).toBe('Open concerns: 1 high.');
    // The link points at this same thread.
    expect(screen.queryByTestId('wisp-post-open')).toBeNull();
  });

  it('renders a nudge_resolved post like a nudge, with the Resolved eyebrow, a check icon and the concern link (#11427)', () => {
    render(<WispPost post={post({ kind: 'nudge_resolved', title: 'Resolved: Disk almost full on FS-01', body: 'Disk almost full on FS-01 — the disk was cleaned; no action needed.' })} />);
    const root = screen.getByTestId('wisp-post');
    expect(root.getAttribute('data-kind')).toBe('nudge_resolved');
    expect(screen.getByText('Resolved')).toBeTruthy();
    expect(screen.getByTestId('wisp-post-resolved-icon')).toBeTruthy();
    expect(screen.getByTestId('wisp-post-title').textContent).toBe('Resolved: Disk almost full on FS-01');
    expect(screen.getByTestId('wisp-post-body').textContent).toBe('Disk almost full on FS-01 — the disk was cleaned; no action needed.');
    expect(screen.getByTestId('wisp-post-open').getAttribute('href')).toBe('/ai/wisp/thread/th-1#concern=c-1');
  });

  it('a plain nudge carries no resolved check icon', () => {
    render(<WispPost post={post({})} />);
    expect(screen.queryByTestId('wisp-post-resolved-icon')).toBeNull();
  });

  it('renders a specialist_result post with the Specialist report heading', () => {
    render(<WispPost post={post({ kind: 'specialist_result', title: 'FS-01 troubleshooting', body: 'Disk cleaned.', link: null, concernId: null })} />);
    expect(screen.getByTestId('wisp-post').getAttribute('data-kind')).toBe('specialist_result');
    expect(screen.getByText('Specialist report')).toBeTruthy();
    expect(screen.getByTestId('wisp-post-title').textContent).toBe('FS-01 troubleshooting');
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

  describe('check_in Run now', () => {
    const checkIn = post({ kind: 'check_in', title: 'Check-in due: x', body: null, link: '/ai/wisp/thread/th-1#checkin=ci-1', concernId: null });

    it('tags the post with the check-in id from its link and shows the clock icon', () => {
      render(<WispPost post={checkIn} />);
      const root = screen.getByTestId('wisp-post');
      expect(root.getAttribute('data-check-in-id')).toBe('ci-1');
      expect(screen.getByTestId('wisp-post-check-in-icon')).toBeTruthy();
    });

    it('a check_in post shows Run now only when onRunNow is given, and clicking calls it', () => {
      const { unmount } = render(<WispPost post={checkIn} />);
      expect(screen.queryByTestId('wisp-post-run-now')).toBeNull();
      unmount();
      const onRunNow = vi.fn();
      render(<WispPost post={checkIn} onRunNow={onRunNow} />);
      const button = screen.getByTestId('wisp-post-run-now');
      expect(button.textContent).toBe('Run now');
      fireEvent.click(button);
      expect(onRunNow).toHaveBeenCalledTimes(1);
    });

    it('Run now is disabled while runNowDisabled', () => {
      const onRunNow = vi.fn();
      render(<WispPost post={checkIn} onRunNow={onRunNow} runNowDisabled />);
      const button = screen.getByTestId('wisp-post-run-now') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
      expect(onRunNow).not.toHaveBeenCalled();
    });

    it('other post kinds never show Run now or a check-in id', () => {
      render(<WispPost post={post({ kind: 'nudge' })} onRunNow={vi.fn()} />);
      expect(screen.queryByTestId('wisp-post-run-now')).toBeNull();
      expect(screen.getByTestId('wisp-post').hasAttribute('data-check-in-id')).toBe(false);
    });
  });
});
