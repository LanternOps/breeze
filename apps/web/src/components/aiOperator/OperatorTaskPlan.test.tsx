import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AiOperatorPlanApprovalDto, AiOperatorPlanEffectDto } from '@breeze/shared';
import OperatorTaskPlan from './OperatorTaskPlan';

function effect(ordinal: number, toolName: string, overrides: Partial<AiOperatorPlanEffectDto> = {}): AiOperatorPlanEffectDto {
  return {
    ordinal, toolName, provider: toolName.startsWith('google_') ? 'google' : 'm365', targetLabel: 'Dana Smith',
    principalLabel: 'dana@example.com', rendering: `${toolName} for dana@example.com`, idempotencyClass: 'idempotent',
    operationState: null, noop: false, ...overrides,
  };
}

function revision(planRevision: number, overrides: Partial<AiOperatorPlanApprovalDto> = {}): AiOperatorPlanApprovalDto {
  return {
    id: `a-${planRevision}`, taskId: 'task-1', planRevision, effectSetDigest: 'd'.repeat(64), effectCount: 2,
    intentId: `i-${planRevision}`, state: 'approved', approvedByUserId: 'u-1', approvedAt: '2026-10-20T10:00:00.000Z',
    supersededByRevision: null, createdAt: '2026-10-20T09:00:00.000Z', effects: [], ...overrides,
  };
}

describe('OperatorTaskPlan', () => {
  it('distinguishes "not sent by this server" from "nothing proposed"', () => {
    const { rerender } = render(<OperatorTaskPlan plan={undefined} />);
    expect(screen.getByTestId('task-plan-unavailable')).toBeInTheDocument();
    rerender(<OperatorTaskPlan plan={[]} />);
    expect(screen.getByTestId('task-plan-empty')).toBeInTheDocument();
  });

  it('shows a superseded revision as superseded — never hidden — beside the current one', () => {
    render(<OperatorTaskPlan plan={[
      revision(1, { state: 'superseded', supersededByRevision: 2, approvedAt: null, approvedByUserId: null, effects: [effect(0, 'm365_disable_user')] }),
      revision(2, { effects: [effect(0, 'm365_disable_user')] }),
    ]} />);
    const r1 = screen.getByTestId('task-plan-revision-1');
    expect(r1).toHaveTextContent('Superseded');
    expect(r1).toHaveTextContent('Superseded by revision 2');
    expect(within(r1).getByTestId('task-plan-effect-0')).toBeInTheDocument();
    expect(screen.getByTestId('task-plan-revision-2')).toHaveTextContent('Approved');
  });

  it('groups effects by provider, keeps the ordinal visible, and shows the frozen labels', () => {
    render(<OperatorTaskPlan plan={[revision(1, { effects: [
      effect(0, 'google_set_vacation'),
      effect(1, 'm365_set_auto_reply', { principalLabel: 'dana@corp.example' }),
      effect(2, 'google_suspend_user', { idempotencyClass: 'non_idempotent' }),
    ] })]} />);
    const rev = screen.getByTestId('task-plan-revision-1');
    const google = within(rev).getByTestId('task-plan-provider-google');
    expect(within(google).getByTestId('task-plan-effect-0')).toBeInTheDocument();
    expect(within(google).getByTestId('task-plan-effect-2')).toHaveTextContent('Never repeated automatically');
    const m365 = within(rev).getByTestId('task-plan-provider-m365');
    expect(within(m365).getByTestId('task-plan-effect-1')).toHaveTextContent('dana@corp.example');
    expect(within(m365).getByTestId('task-plan-effect-1')).toHaveTextContent('Dana Smith');
    expect(within(m365).getByTestId('task-plan-effect-1')).toHaveTextContent('#2');
  });

  it('never renders a null operation state as success', () => {
    render(<OperatorTaskPlan plan={[revision(1, { effects: [
      effect(0, 'm365_disable_user', { operationState: null }),
      effect(1, 'm365_revoke_sessions', { operationState: 'succeeded', noop: true }),
      effect(2, 'm365_remove_license', { operationState: 'unknown' }),
    ] })]} />);
    const none = screen.getByTestId('task-plan-effect-0');
    expect(none).toHaveTextContent('Not started / unknown');
    expect(none).not.toHaveTextContent('Succeeded');
    expect(screen.getByTestId('task-plan-effect-1')).toHaveTextContent('Already in place: nothing was sent.');
    expect(screen.getByTestId('task-plan-effect-2')).toHaveTextContent('Result unknown');
  });
});

// W07 R2b (Task 19). The snapshot below was RECORDED against R1's component
// before R2b touched it, so a one-approval task must keep rendering exactly
// as R1 shipped it.
describe('OperatorTaskPlan — onboarding stages (W07 R2b)', () => {
  it('7. a one-approval task renders byte-identical to R1', () => {
    const { container } = render(<OperatorTaskPlan plan={[revision(1, { effects: [
      effect(0, 'google_set_vacation'),
      effect(1, 'm365_disable_user', { operationState: 'succeeded' }),
    ] })]} />);
    // formatDateTime renders in the runner's timezone: pin structure and copy, not the clock.
    expect(container.innerHTML.replace(/\d{1,2}[./]\d{1,2}[./]\d{4},? \d{1,2}:\d{2}(:\d{2})?(\s?[AP]M)?/gi, '<time>')).toMatchSnapshot();
  });
});

describe('OperatorTaskPlan — two approval stages (W07 R2b)', () => {
  const UPN = 'priya@customer.example';
  const create = revision(1, {
    state: 'superseded', supersededByRevision: 2, approvedByUserId: 'u-approver', approvedAt: '2026-10-20T10:00:00.000Z',
    effectCount: 1,
    effects: [effect(0, 'm365_create_user', { principalLabel: UPN, idempotencyClass: 'non_idempotent', operationState: 'succeeded' })],
  });
  const provision = revision(2, {
    id: 'a-2', effectCount: 2, approvedAt: '2026-10-20T11:00:00.000Z',
    effects: [effect(0, 'm365_assign_license', { principalLabel: UPN }), effect(1, 'm365_add_to_group', { principalLabel: UPN })],
  });

  it('6. renders each approval as its own labelled stage, oldest first, the superseded creation stage still visible', () => {
    render(<OperatorTaskPlan plan={[provision, create]} />);
    const stages = screen.getAllByTestId(/^task-plan-stage-\d+$/);
    expect(stages.map((s) => s.getAttribute('data-testid'))).toEqual(['task-plan-stage-1', 'task-plan-stage-2']);
    const s1 = screen.getByTestId('task-plan-stage-1');
    expect(s1).toHaveTextContent('Approval 1');
    expect(s1).toHaveTextContent('Account creation');
    expect(s1).toHaveTextContent('Superseded');
    // The creation stage names the account it created by the requested sign-in name.
    expect(within(s1).getByTestId('task-plan-effect-0')).toHaveTextContent(UPN);
    const s2 = screen.getByTestId('task-plan-stage-2');
    expect(s2).toHaveTextContent('Approval 2');
    expect(s2).toHaveTextContent('Licences, groups and organizational unit');
    expect(s2).toHaveTextContent('Approved');
  });

  it('a superseded creation approval is not described as "replaced": it ran, and the next stage followed', () => {
    render(<OperatorTaskPlan plan={[create, provision]} />);
    const s1 = screen.getByTestId('task-plan-stage-1');
    expect(s1).toHaveTextContent(/followed by approval 2/i);
    expect(s1).not.toHaveTextContent('Superseded by revision 2');
  });
});

describe('OperatorTaskPlan — review fixes (PR #10128)', () => {
  it('an offboarding re-plan (two revisions, no onboarding stage) renders as R1 did: no stage blocks', () => {
    render(<OperatorTaskPlan plan={[
      revision(1, { state: 'superseded', supersededByRevision: 2, approvedAt: null, approvedByUserId: null, effects: [effect(0, 'm365_disable_user')] }),
      revision(2, { effects: [effect(0, 'm365_disable_user')] }),
    ]} />);
    expect(screen.queryAllByTestId(/^task-plan-stage-\d+$/)).toHaveLength(0);
    expect(screen.queryByText(/^Approval \d/)).toBeNull();
  });

  it('a creation approval superseded by another CREATION (a re-plan) is "superseded", not "followed by the next stage"', () => {
    const UPN = 'priya@customer.example';
    render(<OperatorTaskPlan plan={[
      revision(1, { state: 'superseded', supersededByRevision: 2, effects: [effect(0, 'm365_create_user', { principalLabel: UPN })] }),
      revision(2, { id: 'a-2', effects: [effect(0, 'm365_create_user', { principalLabel: UPN })] }),
    ]} />);
    const s1 = screen.getByTestId('task-plan-stage-1');
    expect(s1).toHaveTextContent('Superseded by revision 2');
    expect(s1).not.toHaveTextContent(/followed by approval/i);
  });
});
