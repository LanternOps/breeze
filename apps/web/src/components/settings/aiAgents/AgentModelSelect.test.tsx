import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('@/stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
import AgentModelSelect from './AgentModelSelect';

const data = {
  surface: 'ai_agents', allowUserChoice: true, defaultOfferingId: 'def', current: null,
  choices: [
    { offeringId: 'def', displayName: 'Sonnet 5.5', contextTokens: 1_000_000, funding: 'platform', priceHint: { inputCentsPerM: 300, outputCentsPerM: 1500, fast: null }, thinkingMode: 'adaptive', options: { effort: [], speed: ['standard'], budgetThinking: false }, defaults: {}, disabled: null },
    { offeringId: 'opus', displayName: 'Opus 5.5', contextTokens: 1_000_000, funding: 'platform', priceHint: { inputCentsPerM: 500, outputCentsPerM: 2500, fast: null }, thinkingMode: 'adaptive', options: { effort: [], speed: ['standard'], budgetThinking: false }, defaults: {}, disabled: { reason: 'permission_required', permission: 'ai_models:premium', roleNames: ['Senior Tech'] } },
  ],
};

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ data }) });
});

describe('AgentModelSelect (W05)', () => {
  it("loads the ai_agents choices for the agent's org and offers \"Use the default (<name>)\"", async () => {
    render(<AgentModelSelect orgId="o1" value={null} onChange={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('ai-agent-model')).toBeInTheDocument());
    expect(fetchWithAuth).toHaveBeenCalledWith('/ai/models/choices/ai-agents?orgId=o1');
    expect(screen.getByTestId('ai-agent-model').textContent).toContain('Sonnet 5.5');
  });
  it('a partner-wide agent loads without an org', async () => {
    render(<AgentModelSelect orgId={null} value={null} onChange={() => undefined} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/ai/models/choices/ai-agents'));
  });
  it('a permission-gated offering is disabled with "requires <role>"', async () => {
    render(<AgentModelSelect orgId="o1" value={null} onChange={() => undefined} />);
    const opt = await screen.findByTestId('ai-agent-model-option-opus');
    expect(opt).toBeDisabled();
    expect(opt.textContent).toContain('Senior Tech');
  });
  it('choosing reports the offering id; the default reports null', async () => {
    const onChange = vi.fn();
    render(<AgentModelSelect orgId="o1" value={'opus'} onChange={onChange} />);
    const select = await screen.findByTestId('ai-agent-model');
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
    fireEvent.change(select, { target: { value: 'def' } });
    expect(onChange).toHaveBeenCalledWith('def');
  });
  it('a stored offering no longer offered still shows (as unavailable), never silently reset', async () => {
    render(<AgentModelSelect orgId="o1" value={'retired-1'} onChange={() => undefined} />);
    expect((await screen.findByTestId('ai-agent-model-option-retired-1')).textContent).toMatch(/unavailable/i);
  });
  it('a malformed response shows the load-failed note and never throws', async () => {
    fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    render(<AgentModelSelect orgId="o1" value={null} onChange={() => undefined} />);
    expect(await screen.findByTestId('ai-agent-model-error')).toBeInTheDocument();
  });
});
