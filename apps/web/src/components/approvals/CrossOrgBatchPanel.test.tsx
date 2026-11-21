import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CrossOrgBatchPanel from './CrossOrgBatchPanel';
import { buildCrossOrgGroups, type CrossOrgGroup, type PendingApproval } from './approvalGrouping';

const NO_DRIFT: ReadonlySet<string> = new Set<string>();

/** An allowlisted (manage_patches:install), batchable card in `orgId`. */
const card = (id: string, orgId: string, overrides: Partial<PendingApproval> = {}): PendingApproval => ({
  id,
  requestingClientLabel: 'Patch Sweep',
  requestingMachineLabel: null,
  actionLabel: `Install 3 updates on HOST-${id}`,
  actionToolName: 'manage_patches',
  actionArguments: { action: 'install' },
  riskTier: 'medium',
  riskSummary: 'Installs pending patches',
  customerTenant: null,
  status: 'pending',
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  decidedAt: null,
  decisionReason: null,
  executionId: null,
  intentId: `intent-${id}`,
  approvalScope: 'supervised',
  isRecursive: false,
  createdAt: '2026-11-21T12:00:00.000Z',
  origin: 'ai_agent',
  agentName: 'Patch Sweep',
  orgId,
  orgName: `Org ${orgId}`,
  action: 'install',
  targetDevice: { id: `device-${id}`, hostname: `HOST-${id}` },
  ...overrides,
});

const groupOf = (rows: PendingApproval[]): CrossOrgGroup => {
  const [group] = buildCrossOrgGroups(rows, NO_DRIFT);
  if (!group) throw new Error('fixture does not form a cross-org group');
  return group;
};

const KEY = 'manage_patches--install';
const onDecide = vi.fn();

const renderPanel = (group: CrossOrgGroup, props: Partial<Parameters<typeof CrossOrgBatchPanel>[0]> = {}) =>
  render(
    <CrossOrgBatchPanel group={group} busy={false} deciding={false} onDecide={onDecide} {...props} />,
  );

const ROWS = [card('a1', 'org-a'), card('b1', 'org-b'), card('a2', 'org-a')];

beforeEach(() => {
  onDecide.mockReset();
  onDecide.mockResolvedValue(undefined);
});

describe('CrossOrgBatchPanel', () => {
  it('collapsed: one summary line and a Review button — no Approve or Deny until review is open', () => {
    renderPanel(groupOf(ROWS));

    expect(screen.getByTestId(`cross-org-batch-summary-${KEY}`)).toHaveTextContent(
      '3 manage_patches:install requests across 2 organizations',
    );
    expect(screen.getByTestId(`cross-org-batch-review-${KEY}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`cross-org-batch-approve-${KEY}`)).toBeNull();
    expect(screen.queryByTestId(`cross-org-batch-deny-${KEY}`)).toBeNull();
    expect(screen.queryByTestId(`cross-org-batch-list-${KEY}`)).toBeNull();
  });

  it('review lists EVERY org and EVERY member — hostname, action label, risk tier — with no truncation', () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => card(`a${i}`, 'org-a')),
      card('b1', 'org-b', { orgName: null, targetDevice: null, riskTier: 'high' }),
    ];
    renderPanel(groupOf(rows));

    fireEvent.click(screen.getByTestId(`cross-org-batch-review-${KEY}`));

    const orgA = screen.getByTestId(`cross-org-batch-org-${KEY}-org-a`);
    expect(orgA).toHaveTextContent('Org org-a');
    expect(orgA).toHaveTextContent('9 requests');
    const orgB = screen.getByTestId(`cross-org-batch-org-${KEY}-org-b`);
    expect(orgB).toHaveTextContent('Unknown organization');
    expect(orgB).toHaveTextContent('1 request');

    for (const row of rows) {
      expect(screen.getByTestId(`cross-org-batch-member-${row.id}`)).toHaveTextContent(row.actionLabel);
    }
    expect(screen.getByTestId('cross-org-batch-member-a8')).toHaveTextContent('HOST-a8');
    expect(screen.getByTestId('cross-org-batch-member-a8')).toHaveTextContent('Medium risk');
    const unknown = screen.getByTestId('cross-org-batch-member-b1');
    expect(unknown).toHaveTextContent('Unknown device');
    expect(unknown).toHaveTextContent('High risk');
    expect(screen.getByTestId(`cross-org-batch-list-${KEY}`)).not.toHaveTextContent(/more/i);
  });

  it('Approve sends exactly the snapshotted members, under the cross-org identity', () => {
    const group = groupOf(ROWS);
    renderPanel(group);

    fireEvent.click(screen.getByTestId(`cross-org-batch-review-${KEY}`));
    fireEvent.click(screen.getByTestId(`cross-org-batch-approve-${KEY}`));

    expect(onDecide).toHaveBeenCalledTimes(1);
    const [frozen, decision, reason] = onDecide.mock.calls[0];
    expect(frozen.identity).toBe(group.identity);
    expect(frozen.members.map((m: PendingApproval) => m.id)).toEqual(['a1', 'b1', 'a2']);
    expect(decision).toBe('approve');
    expect(reason).toBeUndefined();
  });

  it.each([
    ['a card was added', [...ROWS, card('b2', 'org-b')]],
    ['a card was removed', [ROWS[0], ROWS[1]]],
    // Same COUNT, different ids — a count comparison would wave this through.
    ['a card was replaced (same count)', [ROWS[0], ROWS[1], card('a9', 'org-a')]],
  ])('a live change after review (%s) disables Approve/Deny and asks for a re-review', (_label, nextRows) => {
    const { rerender } = renderPanel(groupOf(ROWS));
    fireEvent.click(screen.getByTestId(`cross-org-batch-review-${KEY}`));

    rerender(
      <CrossOrgBatchPanel group={groupOf(nextRows)} busy={false} deciding={false} onDecide={onDecide} />,
    );

    expect(screen.getByTestId(`cross-org-batch-changed-${KEY}`)).toHaveTextContent(
      'This list changed — review it again',
    );
    expect(screen.getByTestId(`cross-org-batch-approve-${KEY}`)).toBeDisabled();
    expect(screen.getByTestId(`cross-org-batch-deny-${KEY}`)).toBeDisabled();
    fireEvent.click(screen.getByTestId(`cross-org-batch-approve-${KEY}`));
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('a re-render with the SAME member set (new objects, new order) stays approvable', () => {
    const { rerender } = renderPanel(groupOf(ROWS));
    fireEvent.click(screen.getByTestId(`cross-org-batch-review-${KEY}`));

    rerender(
      <CrossOrgBatchPanel
        group={groupOf([card('a2', 'org-a'), card('b1', 'org-b'), card('a1', 'org-a')])}
        busy={false}
        deciding={false}
        onDecide={onDecide}
      />,
    );

    expect(screen.queryByTestId(`cross-org-batch-changed-${KEY}`)).toBeNull();
    expect(screen.getByTestId(`cross-org-batch-approve-${KEY}`)).toBeEnabled();
  });

  it('re-review re-snapshots: the new list is shown and Approve sends the new set', () => {
    const { rerender } = renderPanel(groupOf(ROWS));
    fireEvent.click(screen.getByTestId(`cross-org-batch-review-${KEY}`));
    const next = [...ROWS, card('c1', 'org-c')];
    rerender(<CrossOrgBatchPanel group={groupOf(next)} busy={false} deciding={false} onDecide={onDecide} />);
    // The frozen list is still the one that was reviewed.
    expect(screen.queryByTestId('cross-org-batch-member-c1')).toBeNull();

    fireEvent.click(screen.getByTestId(`cross-org-batch-rereview-${KEY}`));

    expect(screen.queryByTestId(`cross-org-batch-changed-${KEY}`)).toBeNull();
    expect(screen.getByTestId('cross-org-batch-member-c1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`cross-org-batch-approve-${KEY}`));
    expect(onDecide.mock.calls[0][0].members.map((m: PendingApproval) => m.id)).toEqual([
      'a1',
      'b1',
      'a2',
      'c1',
    ]);
  });

  it('deny: confirm step with an optional reason (max 500) restating scope, then passes the reason', () => {
    renderPanel(groupOf(ROWS));
    fireEvent.click(screen.getByTestId(`cross-org-batch-review-${KEY}`));

    fireEvent.click(screen.getByTestId(`cross-org-batch-deny-${KEY}`));
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.getByTestId(`cross-org-batch-deny-summary-${KEY}`)).toHaveTextContent(
      'This denies 3 requests across 2 organizations.',
    );
    const reason = screen.getByTestId(`cross-org-batch-deny-reason-${KEY}`);
    expect(reason).toHaveAttribute('maxLength', '500');
    fireEvent.change(reason, { target: { value: 'Outside the change window' } });
    expect(screen.getByTestId(`cross-org-batch-deny-reason-count-${KEY}`)).toHaveTextContent('25');

    fireEvent.click(screen.getByTestId(`cross-org-batch-deny-confirm-${KEY}`));

    expect(onDecide).toHaveBeenCalledTimes(1);
    const [frozen, decision, sent] = onDecide.mock.calls[0];
    expect(frozen.members.map((m: PendingApproval) => m.id)).toEqual(['a1', 'b1', 'a2']);
    expect(decision).toBe('deny');
    expect(sent).toBe('Outside the change window');
  });

  it('disables every action while any decision is in flight, and shows the busy label on its own batch', () => {
    const group = groupOf(ROWS);
    const { rerender } = renderPanel(group);
    fireEvent.click(screen.getByTestId(`cross-org-batch-review-${KEY}`));

    rerender(<CrossOrgBatchPanel group={group} busy deciding={false} onDecide={onDecide} />);
    expect(screen.getByTestId(`cross-org-batch-approve-${KEY}`)).toBeDisabled();
    expect(screen.getByTestId(`cross-org-batch-approve-${KEY}`)).not.toHaveTextContent('Submitting');

    rerender(<CrossOrgBatchPanel group={group} busy deciding onDecide={onDecide} />);
    expect(screen.getByTestId(`cross-org-batch-approve-${KEY}`)).toHaveTextContent('Submitting');
  });

  it('renders the group error inline, with the register link for a missing device', () => {
    const group = groupOf(ROWS);
    const { rerender } = renderPanel(group, { error: 'batchScopeNotPermitted' });
    expect(screen.getByTestId(`cross-org-batch-error-${KEY}`)).toHaveTextContent(
      /partner-level approver/i,
    );

    rerender(
      <CrossOrgBatchPanel group={group} busy={false} deciding={false} error="noApproverDevice" onDecide={onDecide} />,
    );
    expect(screen.getByTestId(`cross-org-batch-error-${KEY}`)).toHaveTextContent(/approver device/i);
  });
});
