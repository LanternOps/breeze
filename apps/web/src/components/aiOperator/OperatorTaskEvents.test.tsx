import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AiOperatorTaskEventDto } from '@breeze/shared';
import OperatorTaskEvents from './OperatorTaskEvents';

function events(n: number, start = 1): AiOperatorTaskEventDto[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `e-${start + i}`, transitionSeq: start + i, eventType: i === 0 ? 'task_admitted' : 'step_opened',
    actorKind: i === 0 ? 'user' : 'coordinator', actorUserId: null, stepKey: 'intake', targetId: null,
    detail: `detail ${start + i}`, createdAt: '2026-10-20T10:00:00.000Z',
  }));
}

describe('OperatorTaskEvents', () => {
  it('renders an explicit empty state', () => {
    render(<OperatorTaskEvents events={[]} />);
    expect(screen.getByTestId('task-events-empty')).toBeInTheDocument();
  });

  it('lists events newest last with actor kind and the bounded detail verbatim', () => {
    render(<OperatorTaskEvents events={events(3)} />);
    const rows = screen.getAllByTestId(/^task-event-\d+$/).map((el) => el.getAttribute('data-testid'));
    expect(rows).toEqual(['task-event-1', 'task-event-2', 'task-event-3']);
    expect(screen.getByTestId('task-event-1')).toHaveTextContent('Task admitted');
    expect(screen.getByTestId('task-event-1')).toHaveTextContent('Person');
    expect(screen.getByTestId('task-event-2')).toHaveTextContent('Coordinator');
    expect(screen.getByTestId('task-event-3')).toHaveTextContent('detail 3');
  });

  it('shows the most recent 200 and reveals the rest of what was fetched on "show all"', () => {
    render(<OperatorTaskEvents events={events(250)} />);
    expect(screen.getAllByTestId(/^task-event-\d+$/)).toHaveLength(200);
    expect(screen.queryByTestId('task-event-1')).toBeNull();
    expect(screen.getByTestId('task-event-250')).toBeInTheDocument();
    expect(screen.getByTestId('task-events-hidden')).toHaveTextContent('50 older events are hidden.');
    fireEvent.click(screen.getByTestId('task-events-show-all'));
    expect(screen.getAllByTestId(/^task-event-\d+$/)).toHaveLength(250);
    expect(screen.queryByTestId('task-events-capped')).toBeNull();
  });

  it('says in words when the server\'s 500-event cap was hit', () => {
    render(<OperatorTaskEvents events={events(500, 101)} />);
    expect(screen.getByTestId('task-events-capped')).toHaveTextContent('Showing the most recent 500 events');
  });
});
