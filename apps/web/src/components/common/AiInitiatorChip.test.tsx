import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AiInitiatorChip } from './AiInitiatorChip';

const ISO = '2026-09-14T00:00:00.000Z';

describe('AiInitiatorChip (#5022 W02, OD-9 A)', () => {
  it('renders nothing for an unmarked row — absence is not a human attribution', () => {
    render(<AiInitiatorChip kind={null} />);
    expect(screen.queryByTestId('ai-initiator-chip')).toBeNull();
  });

  it('renders the assistant variant', () => {
    render(<AiInitiatorChip kind="ai_assistant" />);
    expect(screen.getByTestId('ai-initiator-chip')).toHaveTextContent('AI assistant');
  });

  it('renders the autonomous-agent variant distinctly from the assistant one', () => {
    const { rerender } = render(<AiInitiatorChip kind="ai_assistant" />);
    const assistant = screen.getByTestId('ai-initiator-chip').className;
    rerender(<AiInitiatorChip kind="ai_agent" />);
    expect(screen.getByTestId('ai-initiator-chip').className).not.toEqual(assistant);
    expect(screen.getByTestId('ai-initiator-chip')).toHaveTextContent('AI agent');
  });

  it('shows "origin not available" when the summary is unresolvable, and offers no link', async () => {
    render(
      <AiInitiatorChip
        kind="ai_assistant"
        loadOrigin={async () => ({
          kind: 'ai_assistant',
          label: 'AI assistant',
          occurredAt: ISO,
          toolName: 'run_script',
          resolvable: false,
        })}
      />,
    );
    await userEvent.click(screen.getByTestId('ai-initiator-chip'));
    expect(await screen.findByTestId('ai-origin-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-origin-open-session')).toBeNull();
  });

  it('offers the session link only when the summary carries an id', async () => {
    render(
      <AiInitiatorChip
        kind="ai_assistant"
        loadOrigin={async () => ({
          kind: 'ai_assistant',
          label: 'Support chat',
          occurredAt: ISO,
          toolName: 'run_script',
          resolvable: true,
          session: { id: 'sess-1' },
        })}
      />,
    );
    await userEvent.click(screen.getByTestId('ai-initiator-chip'));
    expect(await screen.findByTestId('ai-origin-open-session')).toBeInTheDocument();
  });

  it('offers the agent-run link when the summary carries a run id', async () => {
    render(
      <AiInitiatorChip
        kind="ai_agent"
        loadOrigin={async () => ({
          kind: 'ai_agent',
          label: 'Patch sweep agent',
          occurredAt: ISO,
          toolName: null,
          resolvable: true,
          agentRun: { id: 'run-1' },
        })}
      />,
    );
    await userEvent.click(screen.getByTestId('ai-initiator-chip'));
    expect(await screen.findByTestId('ai-origin-open-run')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-origin-open-session')).toBeNull();
  });

  it('does not attach a click affordance without loadOrigin', () => {
    render(<AiInitiatorChip kind="ai_assistant" />);
    const chip = screen.getByTestId('ai-initiator-chip');
    expect(chip.closest('button')).toBeNull();
  });

  it('degrades to "origin unavailable" when loadOrigin rejects, rather than an unhandled rejection', async () => {
    render(<AiInitiatorChip kind="ai_assistant" loadOrigin={async () => { throw new Error('network error'); }} />);
    await userEvent.click(screen.getByTestId('ai-initiator-chip'));
    expect(await screen.findByTestId('ai-origin-unavailable')).toBeInTheDocument();
  });
});
