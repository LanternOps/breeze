import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import AiToolCallCard from './AiToolCallCard';

// Assert on the KEY, not a translation: the card's job here is picking the
// right string, and pinning English would make the suite a locale test.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('AiToolCallCard', () => {
  it('renders a human label, not the raw tool name', () => {
    // #5107 — rows read "Manage Alerts"; a technician should read what happened.
    const { container } = render(
      <AiToolCallCard toolName="manage_alerts" output={{ alerts: [] }} />,
    );
    expect(container.textContent).toContain('Updated alerts');
    expect(container.textContent).not.toContain('manage_alerts');
  });

  it('labels an in-flight call in the present tense', () => {
    const { container } = render(<AiToolCallCard toolName="search_logs" isExecuting />);
    expect(container.textContent).toContain('Searching logs');
    expect(container.textContent).toContain('aiToolCallCard.running');
  });

  it('falls back to title case for an unmapped tool', () => {
    const { container } = render(
      <AiToolCallCard toolName="brand_new_tool" output={{}} />,
    );
    expect(container.textContent).toContain('Brand new tool');
  });

  describe('approved-and-executing handoff (#5107)', () => {
    const handoff = { status: 'approved_executing', message: 'Approved…' };

    it('reads a server-asserted handoff as approved and running', () => {
      const { container } = render(
        <AiToolCallCard toolName="manage_services" handoff="approved_executing" isError={false} />,
      );
      expect(container.textContent).toContain('aiToolCallCard.approvedRunning');
      // The status icon must not be the failure one.
      expect(container.querySelector('.text-red-400')).toBeNull();
      expect(container.querySelector('.text-amber-400')).not.toBeNull();
    });

    it('honours the server marker even when isError is set', () => {
      // Unlike `output`, this field cannot be forged by the tool, so it
      // outranks a stale or contradictory isError.
      const { container } = render(
        <AiToolCallCard toolName="manage_services" handoff="approved_executing" isError />,
      );
      expect(container.textContent).toContain('aiToolCallCard.approvedRunning');
      expect(container.querySelector('.text-amber-400')).not.toBeNull();
    });

    it('accepts the payload shape as a history-replay fallback', () => {
      // The SSE-level marker is not persisted on the message row, so a
      // reloaded conversation has only the payload to go on.
      const { container } = render(
        <AiToolCallCard toolName="manage_services" output={handoff} isError={false} />,
      );
      expect(container.textContent).toContain('aiToolCallCard.approvedRunning');
    });

    it('does NOT let a failing tool repaint itself as approved via its own output', () => {
      // A tool owns its output payload. Without the isError gate, any tool —
      // a third-party extension included — could hide a real failure behind
      // the brand-coloured "approved" row that techs scan by.
      const { container } = render(
        <AiToolCallCard
          toolName="manage_services"
          output={{ error: 'restart failed', status: 'approved_executing' }}
          isError
        />,
      );
      expect(container.textContent).not.toContain('aiToolCallCard.approvedRunning');
      expect(container.querySelector('.text-amber-400')).toBeNull();
      expect(container.querySelector('.text-red-400')).not.toBeNull();
    });

    it('does not re-colour a tool that merely mentions the phrase', () => {
      // Shape-based, never a text sniff — the contract the whole fix rests on.
      const { container } = render(
        <AiToolCallCard toolName="search_logs" output={{ line: 'approved_executing' }} />,
      );
      expect(container.textContent).not.toContain('aiToolCallCard.approvedRunning');
      expect(container.querySelector('.text-amber-400')).toBeNull();
      expect(container.querySelector('.text-green-400')).not.toBeNull();
    });

    it('still paints a genuine failure red', () => {
      const { container } = render(
        <AiToolCallCard toolName="manage_services" output={{ error: 'boom' }} isError />,
      );
      expect(container.querySelector('.text-red-400')).not.toBeNull();
      expect(container.querySelector('.text-amber-400')).toBeNull();
    });
  });
});
