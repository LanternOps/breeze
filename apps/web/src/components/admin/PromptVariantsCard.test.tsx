import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('@/stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const res = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body }) as unknown as Response;

import PromptVariantsCard from './PromptVariantsCard';

const metrics = (n: number) => ({
  invocations: n, costCents: n, refusals: 0, refusalRate: 0, failovers: null, failoverRate: null, conversations: n,
  costPerConversationCents: 1, sessions: n, flagged: 0, autoFlagged: 0, flagRate: 0, switchedAway: 0, continued: null,
  leftRate: 0, resolvedSessions: n, medianTurnsToResolution: 3, agentRuns: 0, agentRunsCompleted: 0, agentCompletionRate: null,
});

beforeEach(() => fetchWithAuth.mockReset());

describe('PromptVariantsCard', () => {
  it('renders base and variant rows with state, canary and the low-sample marker', async () => {
    fetchWithAuth.mockResolvedValue(res({
      from: '2026-09-20', to: '2026-10-17', minConversations: 30, sources: { failovers: false, continuations: false },
      rows: [
        { key: 'chat/claude-small@base', surface: 'chat', profile: 'claude-small', variant: null, metrics: metrics(120), lowSample: false, incumbent: true },
        { key: 'chat/claude-small@2', surface: 'chat', profile: 'claude-small', variant: { id: 'chat/claude-small@2', surface: 'chat', profile: 'claude-small', version: 2, state: 'candidate', canaryPercent: 10, hypothesis: 'h' }, metrics: metrics(12), lowSample: true, incumbent: false },
      ],
    }));
    render(<PromptVariantsCard />);
    expect((await screen.findByTestId('prompt-variants-row-chat/claude-small@base')).textContent).toMatch(/Base prompt/);
    expect(screen.getByTestId('prompt-variants-row-chat/claude-small@2').textContent).toMatch(/Candidate.*10%/);
    expect(screen.getByTestId('prompt-variants-low-chat/claude-small@2')).toBeTruthy();
    expect(screen.getByTestId('prompt-variants-incumbent-chat/claude-small@base').textContent).toMatch(/Incumbent/);
    expect(fetchWithAuth).toHaveBeenCalledWith('/admin/ai/prompt-variants');
  });
  it('an empty registry and a failure each have their own state', async () => {
    fetchWithAuth.mockResolvedValueOnce(res({ from: 'a', to: 'b', minConversations: 30, rows: [], sources: { failovers: false, continuations: false } }));
    const { unmount } = render(<PromptVariantsCard />);
    expect(await screen.findByTestId('prompt-variants-empty')).toBeTruthy();
    unmount();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchWithAuth.mockResolvedValueOnce(res({}, 500));
    render(<PromptVariantsCard />);
    expect(await screen.findByTestId('prompt-variants-error')).toBeTruthy();
    err.mockRestore();
  });
});
