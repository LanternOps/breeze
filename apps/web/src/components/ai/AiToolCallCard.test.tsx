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

  /**
   * #6022 — the approval card said "Approved · running" for an action the
   * durable worker had already REFUSED (the #5934 autoInstall guardrail), and
   * the operator was told the install-arming had succeeded.
   */
  describe('terminal post-approval outcomes (#6022)', () => {
    const refusal =
      'Approved, but the action FAILED and did NOT take effect. Reason: Arming autoInstall requires a human operator with devices.execute and MFA.';

    it('renders a worker FAILURE as failed — never as approved and running', () => {
      const { container, getByTestId } = render(
        <AiToolCallCard
          toolName="manage_software_policies"
          handoff="approved_failed"
          output={{ status: 'approved_failed', message: refusal }}
          isError
        />,
      );

      expect(getByTestId('ai-tool-approved-failed')).toBeTruthy();
      expect(container.textContent).toContain('aiToolCallCard.approvedFailed');
      expect(container.textContent).not.toContain('aiToolCallCard.approvedRunning');
      expect(container.querySelector('.text-amber-400')).toBeNull();
      expect(container.querySelector('.text-red-400')).not.toBeNull();
    });

    it('shows the refusal reason WITHOUT expanding the card', () => {
      // Having to click to discover the platform refused your action is the
      // bug, not the fix.
      const { getByTestId } = render(
        <AiToolCallCard
          toolName="manage_software_policies"
          handoff="approved_failed"
          output={{ status: 'approved_failed', message: refusal }}
          isError
        />,
      );
      expect(getByTestId('ai-tool-approved-failed-reason').textContent).toContain(
        'did NOT take effect',
      );
    });

    it('renders a completed outcome distinctly from a still-running one', () => {
      const { container, getByTestId } = render(
        <AiToolCallCard
          toolName="manage_services"
          handoff="approved_completed"
          output={{ status: 'approved_completed', message: 'Approved. …COMPLETED…' }}
          isError={false}
        />,
      );
      expect(getByTestId('ai-tool-approved-completed')).toBeTruthy();
      expect(container.textContent).not.toContain('aiToolCallCard.approvedRunning');
      expect(container.querySelector('.text-green-400')).not.toBeNull();
    });

    it('does not let a tool forge a FAILURE on a non-error result either', () => {
      // The replay fallback is now cross-checked BOTH ways: a payload whose
      // claimed outcome disagrees with the server's isError is ignored.
      const { container } = render(
        <AiToolCallCard
          toolName="search_logs"
          output={{ status: 'approved_failed', message: 'not really' }}
          isError={false}
        />,
      );
      expect(container.textContent).not.toContain('aiToolCallCard.approvedFailed');
      expect(container.querySelector('.text-green-400')).not.toBeNull();
    });

    it('accepts a replayed failure payload when it agrees with isError', () => {
      const { container } = render(
        <AiToolCallCard
          toolName="manage_software_policies"
          output={{ status: 'approved_failed', message: refusal }}
          isError
        />,
      );
      expect(container.textContent).toContain('aiToolCallCard.approvedFailed');
    });
  });

  /**
   * #6500 — a server-refused tool call that never goes through the durable
   * approval handoff (guardrail/RBAC/rate-limit denials, and immediate
   * Tier-1 checks like "device is not online") only ever carried a red icon
   * in the collapsed header; the refusal reason itself was reachable only by
   * expanding the card. Live repro: `system_cleanup` on an offline device
   * rendered with nothing visible to explain the failure. This mirrors the
   * #6022 always-visible treatment onto the plain (non-handoff) isError path.
   */
  describe('plain server refusal without a handoff (#6500)', () => {
    const refusal =
      'Device WIN-DESK01 is not online (status: offline). This tool needs a live connection; to run when the device reconnects use the Run Script / deployment tools instead.';

    it('shows the refusal reason WITHOUT expanding the card', () => {
      const { getByTestId } = render(
        <AiToolCallCard
          toolName="system_cleanup"
          output={{ error: refusal }}
          isError
        />,
      );
      expect(getByTestId('ai-tool-failed-reason').textContent).toContain(
        'is not online',
      );
    });

    it('labels the collapsed header as failed, not a bare icon', () => {
      const { container, getByTestId } = render(
        <AiToolCallCard
          toolName="system_cleanup"
          output={{ error: refusal }}
          isError
        />,
      );
      expect(getByTestId('ai-tool-failed')).toBeTruthy();
      expect(container.textContent).toContain('aiToolCallCard.failed');
      expect(container.querySelector('.text-red-400')).not.toBeNull();
    });

    it('does not show a reason line for a plain successful result', () => {
      const { queryByTestId } = render(
        <AiToolCallCard toolName="query_devices" output={{ devices: [] }} />,
      );
      expect(queryByTestId('ai-tool-failed-reason')).toBeNull();
    });

    it('does not misread a non-string error field as a reason', () => {
      const { queryByTestId } = render(
        <AiToolCallCard
          toolName="system_cleanup"
          output={{ error: { code: 503 } }}
          isError
        />,
      );
      expect(queryByTestId('ai-tool-failed-reason')).toBeNull();
    });

    it('defers to the #6022 handoff reason when a payload carries both shapes', () => {
      // A handoff-failed output could in principle also carry a plain `error`
      // field. The handoff message must win — one reason line, not two.
      const { queryByTestId, getByTestId } = render(
        <AiToolCallCard
          toolName="manage_software_policies"
          handoff="approved_failed"
          output={{
            status: 'approved_failed',
            message: 'Approved, but the action FAILED.',
            error: 'ignored plain-shape error',
          }}
          isError
        />,
      );
      expect(getByTestId('ai-tool-approved-failed-reason').textContent).toContain(
        'Approved, but the action FAILED.',
      );
      expect(queryByTestId('ai-tool-failed-reason')).toBeNull();
      expect(queryByTestId('ai-tool-failed')).toBeNull();
    });
  });
});
