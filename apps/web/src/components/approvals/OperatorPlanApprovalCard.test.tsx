/**
 * The plan approval card (Recipe Library spec §6.4: "The approval card shows
 * the full list, per provider, with the target's frozen labels").
 *
 * One click on this card authorizes up to 64 destructive effects across
 * providers, so every property under test is about what an approver can SEE
 * before approving. A card that summarised ("9 effects") would be the
 * four-eyes bypass §11 warns about.
 *
 * Queries are data-testid only, per e2e-tests/README.md's convention.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import OperatorPlanApprovalCard from './OperatorPlanApprovalCard';

const args = {
  taskId: '00000000-0000-4000-8000-0000000000a1',
  planRevision: 2,
  effectSetDigest: 'a'.repeat(64),
  effects: [
    { ordinal: 0, provider: 'm365', toolName: 'm365_set_auto_reply', targetLabel: 'Dana Ruiz', principalLabel: 'dana@customer.example', rendering: "Set an auto-reply on Dana's M365 mailbox" },
    { ordinal: 1, provider: 'google', toolName: 'google_set_forwarding', targetLabel: 'Dana Ruiz', principalLabel: 'dana@customer.example', rendering: "Forward Dana's Gmail to manager@customer.example" },
    { ordinal: 2, provider: 'google', toolName: 'google_suspend_user', targetLabel: 'Dana Ruiz', principalLabel: 'dana@customer.example', rendering: "Suspend Dana's Google Workspace account" },
  ],
};

describe('OperatorPlanApprovalCard', () => {
  it('renders EVERY effect — no truncation, no "and 6 more"', () => {
    render(<OperatorPlanApprovalCard args={args} />);
    expect(screen.getAllByTestId(/^operator-plan-effect-/)).toHaveLength(3);
  });

  it('renders all 64 effects when the plan is at the cap', () => {
    const many = Array.from({ length: 64 }, (_, i) => ({
      ordinal: i, provider: 'breeze', toolName: 'x', targetLabel: `T${i}`, principalLabel: null, rendering: `r${i}`,
    }));
    render(<OperatorPlanApprovalCard args={{ ...args, effects: many }} />);
    expect(screen.getAllByTestId(/^operator-plan-effect-/)).toHaveLength(64);
  });

  it('groups by provider and labels each group', () => {
    render(<OperatorPlanApprovalCard args={args} />);
    expect(within(screen.getByTestId('operator-plan-group-m365')).getAllByTestId(/^operator-plan-effect-/)).toHaveLength(1);
    expect(within(screen.getByTestId('operator-plan-group-google')).getAllByTestId(/^operator-plan-effect-/)).toHaveLength(2);
    expect(screen.queryByTestId('operator-plan-group-breeze')).toBeNull();
  });

  it('orders groups breeze, m365, google regardless of effect order', () => {
    const mixed = {
      ...args,
      effects: [
        { ...args.effects[2]!, ordinal: 0 },
        { ...args.effects[0]!, ordinal: 1 },
        { ordinal: 2, provider: 'breeze', toolName: 'b', targetLabel: 'PC1', principalLabel: null, rendering: 'Restart PC1' },
      ],
    };
    render(<OperatorPlanApprovalCard args={mixed} />);
    const groups = screen.getAllByTestId(/^operator-plan-group-/).map((g) => g.getAttribute('data-testid'));
    expect(groups).toEqual(['operator-plan-group-breeze', 'operator-plan-group-m365', 'operator-plan-group-google']);
  });

  it('shows the FROZEN target and principal labels, not a re-resolved name', () => {
    render(<OperatorPlanApprovalCard args={args} />);
    expect(screen.getByTestId('operator-plan-effect-2')).toHaveTextContent('Dana Ruiz');
    expect(screen.getByTestId('operator-plan-effect-2')).toHaveTextContent('dana@customer.example');
  });

  it('omits the principal parenthetical when principalLabel is null', () => {
    render(<OperatorPlanApprovalCard args={{ ...args, effects: [{ ...args.effects[0]!, principalLabel: null }] }} />);
    const row = screen.getByTestId('operator-plan-effect-0');
    expect(row).toHaveTextContent('Dana Ruiz');
    expect(row).not.toHaveTextContent('()');
  });

  it('preserves DISPATCH ORDER inside a group and shows the ordinal', () => {
    // §6.3's ordering is a safety contract: suspend is last so a stopped task
    // never leaves a disabled account with mail unrouted.
    render(<OperatorPlanApprovalCard args={args} />);
    const rows = screen.getAllByTestId(/^operator-plan-effect-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'operator-plan-effect-0', 'operator-plan-effect-1', 'operator-plan-effect-2',
    ]);
    expect(rows[2]).toHaveTextContent('3');
  });

  it('sorts by ordinal inside a group even if the payload order differs', () => {
    render(<OperatorPlanApprovalCard args={{ ...args, effects: [args.effects[2]!, args.effects[1]!] }} />);
    const rows = within(screen.getByTestId('operator-plan-group-google')).getAllByTestId(/^operator-plan-effect-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['operator-plan-effect-1', 'operator-plan-effect-2']);
  });

  it('shows the plan revision and the effect count', () => {
    render(<OperatorPlanApprovalCard args={args} />);
    expect(screen.getByTestId('operator-plan-summary')).toHaveTextContent('2');
    expect(screen.getByTestId('operator-plan-summary')).toHaveTextContent('3');
  });

  it('renders an explicit empty state rather than an empty list', () => {
    render(<OperatorPlanApprovalCard args={{ ...args, effects: [] }} />);
    expect(screen.getByTestId('operator-plan-empty')).toBeInTheDocument();
  });

  it('renders the empty/invalid state, not a crash, for malformed arguments', () => {
    const { rerender } = render(<OperatorPlanApprovalCard args={{ effects: 'nope' }} />);
    expect(screen.getByTestId('operator-plan-empty')).toBeInTheDocument();
    rerender(<OperatorPlanApprovalCard args={null} />);
    expect(screen.getByTestId('operator-plan-empty')).toBeInTheDocument();
    rerender(<OperatorPlanApprovalCard args={{ ...args, effects: [{ ordinal: 0 }, null, 'x'] }} />);
    expect(screen.getByTestId('operator-plan-empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^operator-plan-effect-/)).toHaveLength(0);
  });

  it('escapes rendering text — it is server-supplied and must never be HTML', () => {
    render(<OperatorPlanApprovalCard args={{
      ...args, effects: [{ ...args.effects[0]!, rendering: '<img src=x onerror=alert(1)>' }],
    }} />);
    expect(screen.getByTestId('operator-plan-effect-0')).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
  });
});
