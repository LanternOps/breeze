import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AiOperatorTaskDto, AiOperatorTaskStepDto, AiOperatorTaskTargetRowDto } from '@breeze/shared';
import OperatorTaskSteps from './OperatorTaskSteps';

const TICKET = '99999999-9999-4999-8999-999999999999';

function step(stepKey: string, overrides: Partial<AiOperatorTaskStepDto> = {}): AiOperatorTaskStepDto {
  return {
    id: `s-${stepKey}-${overrides.attemptOrdinal ?? 0}`, stepKey, stepKind: 'reason', targetId: null, attemptOrdinal: 0,
    state: 'succeeded', planRevision: 1, expectedCriterion: null, dependency: null, detail: null,
    startedAt: '2026-10-20T10:00:00.000Z', settledAt: '2026-10-20T10:01:00.000Z', ...overrides,
  };
}

const ticketTarget: AiOperatorTaskTargetRowDto = {
  id: 't-ticket', targetKind: 'ticket', deviceId: null, ticketId: TICKET, contactId: null, label: 'T-1',
  ordinal: 1, state: 'active', detachedAt: null, detachedReason: null, accounts: [],
};

type TaskSlice = Pick<AiOperatorTaskDto, 'steps' | 'targets' | 'currentStepKey' | 'waitReason' | 'state'>;
const task = (o: Partial<TaskSlice>): TaskSlice => ({
  steps: [], targets: [], currentStepKey: null, waitReason: null, state: 'running', ...o,
});

describe('OperatorTaskSteps', () => {
  it('renders an explicit empty state', () => {
    render(<OperatorTaskSteps task={task({})} />);
    expect(screen.getByTestId('task-steps-empty')).toBeInTheDocument();
  });

  it('D1: effects is ONE row whose waiting reason follows the task — approval, then the maintenance window', () => {
    const steps = [
      step('intake', { startedAt: '2026-10-20T10:00:00.000Z' }),
      step('effects', { stepKind: 'effect', state: 'waiting', settledAt: null, startedAt: '2026-10-20T11:00:00.000Z', dependency: { kind: 'intent', id: 'i-1' } }),
    ];
    const { rerender } = render(<OperatorTaskSteps task={task({ steps, currentStepKey: 'effects', waitReason: 'approval', state: 'waiting' })} />);
    const effects = screen.getByTestId('task-step-effects');
    expect(within(effects).getAllByTestId(/^task-step-effects-\d+$/)).toHaveLength(1);
    expect(effects).toHaveTextContent('Waiting for approval of the plan.');
    expect(effects).toHaveAttribute('aria-current', 'step');
    // No invented phase rows.
    expect(screen.queryByTestId('task-step-plan_approval')).toBeNull();
    expect(screen.queryByTestId('task-step-wait_cutoff')).toBeNull();
    expect(screen.queryByTestId('task-step-device_actions')).toBeNull();

    rerender(<OperatorTaskSteps task={task({ steps, currentStepKey: 'effects', waitReason: 'maintenance_window', state: 'waiting' })} />);
    expect(screen.getByTestId('task-step-effects')).toHaveTextContent('Waiting for the maintenance window');
    rerender(<OperatorTaskSteps task={task({ steps, currentStepKey: 'effects', waitReason: 'execution', state: 'waiting' })} />);
    expect(screen.getByTestId('task-step-effects')).toHaveTextContent('waiting for the current change to finish');
  });

  it('a human_work step says what it waits for, links its checklist ticket, and shows who completed it', () => {
    const steps = [
      step('manual_work', { stepKind: 'human_work', state: 'waiting', attemptOrdinal: 0, settledAt: null, dependency: { kind: 'user_answer', id: 'item-1' }, detail: 'waiting on a person: Collect Dana’s laptop', startedAt: '2026-10-20T12:00:00.000Z' }),
      step('manual_work', { stepKind: 'human_work', state: 'succeeded', attemptOrdinal: 1, detail: 'completed by user u-1 at 2026-10-20T12:30:00.000Z', startedAt: '2026-10-20T12:00:01.000Z' }),
    ];
    render(<OperatorTaskSteps task={task({ steps, targets: [ticketTarget], currentStepKey: 'manual_work', waitReason: 'information', state: 'waiting' })} />);
    const waiting = screen.getByTestId('task-step-manual_work-0');
    expect(waiting).toHaveTextContent('Waiting for a technician to tick the checklist item on the ticket.');
    expect(waiting).toHaveTextContent('Collect Dana’s laptop');
    expect(within(waiting).getByRole('link')).toHaveAttribute('href', `/tickets/${TICKET}`);
    expect(screen.getByTestId('task-step-manual_work-1')).toHaveTextContent('completed by user u-1');
  });

  it('marks only the current step, and shows the spine in the order the rows started', () => {
    const steps = [
      step('discover', { stepKind: 'probe', startedAt: '2026-10-20T10:02:00.000Z' }),
      step('intake', { startedAt: '2026-10-20T10:00:00.000Z' }),
      step('confirm_identity', { stepKind: 'human_work', startedAt: '2026-10-20T10:01:00.000Z' }),
    ];
    render(<OperatorTaskSteps task={task({ steps, currentStepKey: 'discover' })} />);
    const groups = screen.getAllByTestId(/^task-step-[a-z_]+$/).map((el) => el.getAttribute('data-testid'));
    expect(groups).toEqual(['task-step-intake', 'task-step-confirm_identity', 'task-step-discover']);
    expect(screen.getByTestId('task-step-discover')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByTestId('task-step-intake')).not.toHaveAttribute('aria-current');
  });
});

// W07 R2b (Task 19): identity_onboarding's twelve step keys (Amendment B1).
describe('OperatorTaskSteps — identity_onboarding (W07 R2b)', () => {
  const ONBOARDING_KEYS = [
    'intake', 'confirm_details', 'discover', 'review', 'create_accounts', 'manual_create_google',
    'resolve_accounts', 'provision_effects', 'wait_start', 'manual_work', 'verify_outcome', 'document',
  ];

  it('labels every one of the twelve step keys (none falls through to its raw key)', () => {
    const steps = ONBOARDING_KEYS.map((k, i) => step(k, { startedAt: new Date(Date.UTC(2026, 9, 20, 10, i)).toISOString() }));
    render(<OperatorTaskSteps task={{ ...task({ steps }), workflowKey: 'identity_onboarding' }} />);
    const groups = screen.getAllByTestId(/^task-step-[a-z_]+$/).map((el) => el.getAttribute('data-testid'));
    expect(groups).toEqual(ONBOARDING_KEYS.map((k) => `task-step-${k}`));
    for (const k of ONBOARDING_KEYS) {
      const label = screen.getByTestId(`task-step-${k}`).querySelector('.font-medium')?.textContent ?? '';
      expect(label, k).not.toBe(k);
      expect(label.length, k).toBeGreaterThan(0);
    }
    expect(screen.getByTestId('task-step-manual_work')).toHaveTextContent('Handover checklist');
  });

  it('offboarding\'s manual_work keeps its R1 label', () => {
    render(<OperatorTaskSteps task={{ ...task({ steps: [step('manual_work')] }), workflowKey: 'identity_offboarding' }} />);
    expect(screen.getByTestId('task-step-manual_work')).toHaveTextContent('Checklist work');
  });

  it('manual_create_google is human work: it waits on the checklist ticket and shows the item\'s instructions verbatim', () => {
    const instructions = 'waiting on a person: Create Priya Patel\'s Google Workspace account\nPrimary email: priya@customer-mail.example';
    const steps = [step('manual_create_google', {
      stepKind: 'human_work', state: 'waiting', settledAt: null, dependency: { kind: 'user_answer', id: 'item-g' }, detail: instructions,
    })];
    render(<OperatorTaskSteps task={task({ steps, targets: [ticketTarget], currentStepKey: 'manual_create_google', waitReason: 'information', state: 'waiting' })} />);
    const row = screen.getByTestId('task-step-manual_create_google-0');
    expect(row).toHaveTextContent('Waiting for a technician to tick the checklist item on the ticket.');
    expect(row).toHaveTextContent('Primary email: priya@customer-mail.example');
    expect(within(row).getByRole('link')).toHaveAttribute('href', `/tickets/${TICKET}`);
  });
});
