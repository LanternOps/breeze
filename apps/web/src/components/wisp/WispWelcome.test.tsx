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
