import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Concern } from '@breeze/shared';

const h = vi.hoisted(() => ({ panelProps: null as null | Record<string, unknown> }));
vi.mock('../ai/WispConcernsPanel', () => ({
  WispConcernsPanel: (props: Record<string, unknown>) => {
    h.panelProps = props;
    return <div data-testid="wisp-concerns-mock" />;
  },
}));

import WispNeedsYou from './WispNeedsYou';

const concern = (id: string, status: Concern['status'], approvalIntentId: string | null = null) =>
  ({ id, status, severity: 'high', approvalIntentId }) as unknown as Concern;

describe('WispNeedsYou (W08 Task 9)', () => {
  beforeEach(() => { h.panelProps = null; });

  it('heads the section with the live count and the approvals waiting, from the home payload first', () => {
    render(<WispNeedsYou grantId="g-1" threadId="th-1" initial={[concern('a', 'open', 'ai-1'), concern('b', 'snoozed')]} />);
    expect(screen.getByRole('heading', { name: 'Needs your attention' })).toBeInTheDocument();
    expect(screen.getByTestId('wisp-needs-you-count')).toHaveTextContent('2 items');
    expect(screen.getByTestId('wisp-needs-you-approvals')).toHaveTextContent('1 waiting for your approval');
  });

  it('reuses the grant-wide concern panel (cross-org, untitled) and follows its loads', () => {
    render(<WispNeedsYou grantId="g-1" threadId="th-1" initial={[concern('a', 'open', 'ai-1')]} />);
    expect(h.panelProps).toMatchObject({ grantId: 'g-1', threadId: 'th-1', crossOrg: true, title: '' });
    // The user dismissed the approval elsewhere and the panel reloaded; a resolved row
    // (shown under "show all") does not count.
    act(() => (h.panelProps?.onLoaded as (c: Concern[]) => void)([concern('b', 'open'), concern('c', 'resolved')]));
    expect(screen.getByTestId('wisp-needs-you-count')).toHaveTextContent('1 item');
    expect(screen.queryByTestId('wisp-needs-you-approvals')).toBeNull();
  });

  it('passes refreshKey through so the host can reload the concerns (#10104)', () => {
    render(<WispNeedsYou grantId="g-1" threadId="th-1" initial={[]} refreshKey={4} />);
    expect(h.panelProps).toMatchObject({ refreshKey: 4 });
  });

  it('shows no count chip when nothing is waiting', () => {
    render(<WispNeedsYou grantId="g-1" threadId="th-1" initial={[]} />);
    expect(screen.queryByTestId('wisp-needs-you-count')).toBeNull();
  });
});
