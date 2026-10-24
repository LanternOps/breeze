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
