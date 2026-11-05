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
      render(<WispWelcome scopeLabel="Acme" onSuggest={vi.fn()} firstLook />);
      expect(screen.getByText("I've had a first look at Acme.")).toBeInTheDocument();
      expect(screen.getByText('What I found is in the post above. Ask me anything about it.')).toBeInTheDocument();
      expect(screen.queryByText("I'm looking around Acme.")).toBeNull();
      expect(screen.queryByText(/once I have had a look/)).toBeNull();
    });

    it('names the brief time and the resolved zone, looking or not', () => {
      const { rerender } = render(<WispWelcome scopeLabel="Acme" onSuggest={vi.fn()} briefSchedule={schedule} />);
      expect(screen.getByTestId('wisp-welcome-brief-at')).toHaveTextContent('Your morning brief goes out at 08:00 (America/Denver).');
      rerender(<WispWelcome scopeLabel="Acme" onSuggest={vi.fn()} briefSchedule={schedule} firstLook />);
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
