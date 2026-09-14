import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { TicketProposalCard } from './TicketProposalCard';

const t = ((k: string) => k) as never;
const proposal = { version: 1 as const, summary: 'Spooler wedged; restarted.', notes: ['Check driver'] };

describe('TicketProposalCard (#4211)', () => {
  it('renders the summary under the existing triage testids', () => {
    render(<TicketProposalCard proposal={proposal} t={t} />);
    expect(screen.getByTestId('ai-agent-run-triage-summary')).toHaveTextContent('Spooler wedged; restarted.');
  });

  it('hides the post button when no handler is supplied', () => {
    render(<TicketProposalCard proposal={proposal} t={t} />);
    expect(screen.queryByTestId('ai-agent-run-triage-post-note')).toBeNull();
  });

  it('calls onPostNote with the summary when clicked', async () => {
    const onPostNote = vi.fn();
    render(<TicketProposalCard proposal={proposal} t={t} onPostNote={onPostNote} />);
    await userEvent.click(screen.getByTestId('ai-agent-run-triage-post-note'));
    expect(onPostNote).toHaveBeenCalledWith('Spooler wedged; restarted.');
  });
});
