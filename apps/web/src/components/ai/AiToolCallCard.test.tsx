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

    it('reads as approved and running, not as an error', () => {
      const { container } = render(
        <AiToolCallCard toolName="manage_services" output={handoff} isError={false} />,
      );
      expect(container.textContent).toContain('aiToolCallCard.approvedRunning');
      // The status icon must not be the failure one.
      expect(container.querySelector('.text-red-400')).toBeNull();
      expect(container.querySelector('.text-amber-400')).not.toBeNull();
    });

    it('stays approved even if isError is still set by a stale server', () => {
      const { container } = render(
        <AiToolCallCard toolName="manage_services" output={handoff} isError />,
      );
      expect(container.textContent).toContain('aiToolCallCard.approvedRunning');
      expect(container.querySelector('.text-amber-400')).not.toBeNull();
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
