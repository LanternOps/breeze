import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import WispWelcome from './WispWelcome';

describe('WispWelcome (W01 Task 7)', () => {
  it('renders the welcome copy with the scope', () => {
    render(<WispWelcome scopeLabel="Acme" onSuggest={vi.fn()} />);
    expect(screen.getByTestId('wisp-welcome')).toBeInTheDocument();
    expect(screen.getByText('Wisp')).toBeInTheDocument();
    expect(screen.getByText("I'm looking around Acme.")).toBeInTheDocument();
    expect(
      screen.getByText('Your first brief arrives each morning once I have had a look. Ask me anything in the meantime.'),
    ).toBeInTheDocument();
  });

  it('intro=false keeps only the chips (a brief is already on screen)', () => {
    render(<WispWelcome scopeLabel="Acme" onSuggest={vi.fn()} intro={false} />);
    expect(screen.queryByText("I'm looking around Acme.")).toBeNull();
    expect(screen.queryByText(/Your first brief arrives/)).toBeNull();
    expect(screen.getAllByTestId('wisp-suggestion')).toHaveLength(4);
  });

  describe('#10402', () => {
    const schedule = { timeLocal: '08:00', timezone: 'America/Denver', browserTimezone: 'America/Denver' };

    it('after the first look the title says so, and "looking around" is gone', () => {
      render(<WispWelcome scopeLabel="Acme" onSuggest={vi.fn()} firstLookState="done" />);
      expect(screen.getByText("I've had a first look at Acme.")).toBeInTheDocument();
      expect(screen.getByText('What I found is in the post above. Ask me anything about it.')).toBeInTheDocument();
      expect(screen.queryByText("I'm looking around Acme.")).toBeNull();
      expect(screen.queryByText(/once I have had a look/)).toBeNull();
    });

    it('names the brief time and the resolved zone, looking or not', () => {
      const { rerender } = render(<WispWelcome scopeLabel="Acme" onSuggest={vi.fn()} briefSchedule={schedule} />);
      expect(screen.getByTestId('wisp-welcome-brief-at')).toHaveTextContent('Your morning brief goes out at 08:00 (America/Denver).');
      rerender(<WispWelcome scopeLabel="Acme" onSuggest={vi.fn()} briefSchedule={schedule} firstLookState="done" />);
      expect(screen.getByTestId('wisp-welcome-brief-at')).toHaveTextContent('08:00 (America/Denver)');
    });

    it('no line with the brief off, without a schedule, or on a chat surface', () => {
      const { rerender } = render(<WispWelcome scopeLabel="Acme" onSuggest={vi.fn()} briefSchedule={{ ...schedule, timeLocal: null }} />);
      expect(screen.queryByTestId('wisp-welcome-brief-at')).toBeNull();
      rerender(<WispWelcome scopeLabel="Acme" onSuggest={vi.fn()} />);
      expect(screen.queryByTestId('wisp-welcome-brief-at')).toBeNull();
      rerender(<WispWelcome scopeLabel="Acme" onSuggest={vi.fn()} briefSchedule={schedule} briefNote={false} />);
      expect(screen.queryByTestId('wisp-welcome-brief-at')).toBeNull();
    });
  });

  describe("#11145: nothing could be looked at", () => {
    it('says so instead of "looking around" or "first look", and points at the post', () => {
      render(<WispWelcome scopeLabel="Acme" onSuggest={vi.fn()} firstLookState="couldnt_look" />);
      expect(screen.getByText("I couldn't look at Acme yet.")).toBeInTheDocument();
      expect(screen.getByTestId('wisp-welcome-couldnt-look')).toHaveTextContent("The post above says why and when I'll try again.");
      expect(screen.queryByText(/looking around/)).toBeNull();
      expect(screen.queryByText(/first look/)).toBeNull();
      expect(screen.queryByText(/once I have had a look/)).toBeNull();
    });

    it('a chat surface has no post above: it points at the Wisp home', () => {
      render(<WispWelcome scopeLabel="Acme" onSuggest={vi.fn()} firstLookState="couldnt_look" briefNote={false} />);
      expect(screen.getByText("I couldn't look at Acme yet.")).toBeInTheDocument();
      expect(screen.getByTestId('wisp-welcome-couldnt-look')).toHaveTextContent("The Wisp home says why and when I'll try again.");
    });
  });

  describe('#11146: progress', () => {
    const progress = { lookedAtOrgs: 3, queuedOrgs: 8, failedOrgs: 1, totalOrgs: 12 };

    it('shows looked at, queued and failed while looking', () => {
      render(<WispWelcome scopeLabel="Acme" onSuggest={vi.fn()} firstLookProgress={progress} />);
      expect(screen.getByTestId('wisp-welcome-progress-looked')).toHaveTextContent('3 of 12 organizations looked at');
      expect(screen.getByTestId('wisp-welcome-progress-queued')).toHaveTextContent('8 queued');
      expect(screen.getByTestId('wisp-welcome-progress-failed')).toHaveTextContent('1 failed');
    });

    it('leaves out a count of zero, and one org reads as singular', () => {
      render(<WispWelcome scopeLabel="Acme" onSuggest={vi.fn()} firstLookProgress={{ lookedAtOrgs: 0, queuedOrgs: 1, failedOrgs: 0, totalOrgs: 1 }} />);
      expect(screen.getByTestId('wisp-welcome-progress-looked')).toHaveTextContent('0 of 1 organization looked at');
      expect(screen.getByTestId('wisp-welcome-progress-queued')).toBeInTheDocument();
      expect(screen.queryByTestId('wisp-welcome-progress-failed')).toBeNull();
    });

    it.each(['done', 'couldnt_look'] as const)('disappears once the state is %s, even with counts still on hand', (state) => {
      render(<WispWelcome scopeLabel="Acme" onSuggest={vi.fn()} firstLookState={state} firstLookProgress={progress} />);
      expect(screen.queryByTestId('wisp-welcome-progress')).toBeNull();
    });

    it('no line without counts, and none when the intro is off', () => {
      const { rerender } = render(<WispWelcome scopeLabel="Acme" onSuggest={vi.fn()} />);
      expect(screen.queryByTestId('wisp-welcome-progress')).toBeNull();
      rerender(<WispWelcome scopeLabel="Acme" onSuggest={vi.fn()} intro={false} firstLookProgress={progress} />);
      expect(screen.queryByTestId('wisp-welcome-progress')).toBeNull();
    });
  });

  it('each chip sends its prompt', () => {
    const onSuggest = vi.fn();
    render(<WispWelcome scopeLabel="Acme" onSuggest={onSuggest} />);
    const chips = screen.getAllByTestId('wisp-suggestion');
    expect(chips).toHaveLength(4);
    const expected = [
      ['What needs me today?', 'What needs my attention today? Keep it short.'],
      ['Which devices are offline?', 'Which of my devices are offline right now?'],
      ['Run a health sweep', 'Run a health sweep on Acme now.'],
      ['What happened overnight?', 'What happened across my customers overnight?'],
    ];
    expected.forEach(([label, prompt], i) => {
      expect(chips[i]).toHaveTextContent(label);
      fireEvent.click(chips[i]);
      expect(onSuggest).toHaveBeenLastCalledWith(prompt);
    });
    expect(onSuggest).toHaveBeenCalledTimes(4);
  });
});
