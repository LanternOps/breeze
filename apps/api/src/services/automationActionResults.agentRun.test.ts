/**
 * #5290 — an `ai_triage` action is terminalised by the CHILD agent run's own
 * terminal events, not by the enqueue that started it.
 *
 * These cases exercise the pure decision layer (`decideTerminalTransition` with
 * the new `agent_run` source) plus the event-to-status mapping in
 * `automationTerminalEvidence`. The correlation write itself is proven against
 * a real database in `monitorEpisodes.integration.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { applyAutomationActionTerminalMock } = vi.hoisted(() => ({
  applyAutomationActionTerminalMock: vi.fn(),
}));

vi.mock('./automationActionResults', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./automationActionResults')>()),
  applyAutomationActionTerminal: applyAutomationActionTerminalMock,
}));

import {
  applyAgentRunAutomationTerminal,
  handleAgentRunTerminalForAutomation,
  mapAgentRunTerminalEvidence,
} from './automationTerminalEvidence';
import { __testOnly } from './automationActionResults';

const QUEUED_AI_TRIAGE = {
  status: 'queued' as const,
  terminalSource: null,
  commandId: null,
  scriptExecutionId: null,
  deploymentResultId: null,
  agentRunId: 'agent-run-1',
};

beforeEach(() => {
  applyAutomationActionTerminalMock.mockReset();
  applyAutomationActionTerminalMock.mockResolvedValue(true);
});

describe('agent_run terminal transitions', () => {
  it.each([
    ['succeeded'],
    ['failed'],
    ['skipped'],
  ] as const)('terminalises a queued ai_triage action as %s', (terminalStatus) => {
    expect(
      __testOnly.decideTerminalTransition(QUEUED_AI_TRIAGE, {
        source: 'agent_run',
        terminalStatus,
        output: null,
        error: null,
        completedAt: new Date('2026-09-13T12:00:00Z'),
      }),
    ).toMatchObject({ status: terminalStatus, terminalSource: 'agent_run' });
  });

  it('does not overwrite an action that is already terminal', () => {
    expect(
      __testOnly.decideTerminalTransition(
        { ...QUEUED_AI_TRIAGE, status: 'succeeded', terminalSource: 'dispatch' },
        {
          source: 'agent_run',
          terminalStatus: 'failed',
          output: null,
          error: null,
          completedAt: new Date(),
        },
      ),
    ).toBeNull();
  });

  it('replaces a provisional reaper timeout, because agent_run is real evidence', () => {
    expect(
      __testOnly.decideTerminalTransition(
        { ...QUEUED_AI_TRIAGE, status: 'timed_out', terminalSource: 'reaper' },
        {
          source: 'agent_run',
          terminalStatus: 'succeeded',
          output: null,
          error: null,
          completedAt: new Date(),
        },
      ),
    ).toMatchObject({ status: 'succeeded', terminalSource: 'agent_run' });
  });
});

describe('mapAgentRunTerminalEvidence', () => {
  it.each([
    ['ai.agent.run.completed', 'succeeded'],
    ['ai.agent.run.failed', 'failed'],
    ['ai.agent.run.skipped', 'skipped'],
  ] as const)('maps %s to %s', (eventType, expected) => {
    expect(mapAgentRunTerminalEvidence(eventType)).toBe(expected);
  });

  it('returns null for an unrelated event type', () => {
    expect(mapAgentRunTerminalEvidence('ai.agent.run.started')).toBeNull();
  });
});

describe('applyAgentRunAutomationTerminal', () => {
  it('records terminal_source agent_run against the agent run id', async () => {
    await applyAgentRunAutomationTerminal({
      agentRunId: 'agent-run-1',
      terminalStatus: 'succeeded',
      completedAt: new Date('2026-09-13T12:00:00Z'),
    });

    expect(applyAutomationActionTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent_run',
        agentRunId: 'agent-run-1',
        terminalStatus: 'succeeded',
      }),
    );
  });
});

describe('handleAgentRunTerminalForAutomation', () => {
  it('is a no-op for an event with no run id', async () => {
    await handleAgentRunTerminalForAutomation({
      type: 'ai.agent.run.completed',
      orgId: 'org-1',
      payload: {},
    } as never);

    expect(applyAutomationActionTerminalMock).not.toHaveBeenCalled();
  });

  it('is a no-op for an unrelated event type', async () => {
    await handleAgentRunTerminalForAutomation({
      type: 'ai.agent.run.started',
      orgId: 'org-1',
      payload: { runId: 'agent-run-1' },
    } as never);

    expect(applyAutomationActionTerminalMock).not.toHaveBeenCalled();
  });

  it('terminalises the correlated action from the event payload', async () => {
    await handleAgentRunTerminalForAutomation({
      type: 'ai.agent.run.failed',
      orgId: 'org-1',
      payload: { runId: 'agent-run-1', error: 'boom' },
    } as never);

    expect(applyAutomationActionTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent_run',
        agentRunId: 'agent-run-1',
        terminalStatus: 'failed',
        error: 'boom',
      }),
    );
  });
});
