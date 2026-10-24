import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiOperatorWorkflowDto } from '@breeze/shared';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '../../stores/auth';
import RecipeLibrary from './RecipeLibrary';

const fetchMock = vi.mocked(fetchWithAuth);
const ORG = '11111111-1111-4111-8111-111111111111';

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

function workflow(overrides: Partial<AiOperatorWorkflowDto> = {}): AiOperatorWorkflowDto {
  return {
    recipeKey: 'identity_offboarding', recipeVersion: 3, name: 'Offboard a person', summary: 's',
    gateClass: 'deterministic', targetKinds: ['contact'], readiness: 'ready', missingCapabilities: [],
    alwaysManualCapabilities: [], manualStepCount: 0, degradedEffects: [], agentId: null, agentKind: 'helpdesk',
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  window.location.hash = '';
});
afterEach(() => vi.clearAllMocks());

describe('RecipeLibrary', () => {
  it('renders a loading state, then the cards', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { resolve = r; }));
    render(<RecipeLibrary orgId={ORG} />);
    expect(screen.getByTestId('recipe-library-loading')).toBeInTheDocument();
    await act(async () => { resolve(json({ data: [workflow()] })); });
    expect(await screen.findByTestId('recipe-card-identity_offboarding')).toBeInTheDocument();
  });

  it('renders a load failure with a retry that refetches', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'x' }, 500));
    render(<RecipeLibrary orgId={ORG} />);
    expect(await screen.findByTestId('recipe-library-error')).toBeInTheDocument();
    fetchMock.mockResolvedValueOnce(json({ data: [workflow()] }));
    fireEvent.click(screen.getByTestId('recipe-library-retry'));
    expect(await screen.findByTestId('recipe-card-identity_offboarding')).toBeInTheDocument();
  });

  it('renders an explicit empty state, never a blank panel', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [] }));
    render(<RecipeLibrary orgId={ORG} />);
    expect(await screen.findByTestId('recipe-library-empty')).toHaveTextContent('No recipes are available for this organization yet.');
  });

  it('asks for an organization instead of fetching when none is selected', () => {
    render(<RecipeLibrary orgId={null} />);
    expect(screen.getByTestId('recipe-library-no-org')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the selected recipe in the hash (#recipe=…), keeping other keys, and round-trips it', async () => {
    window.location.hash = 'tab=library';
    fetchMock.mockImplementation(async () => json({ data: [workflow()] }));
    const renderStart = vi.fn((w: AiOperatorWorkflowDto) => <div data-testid="start-panel">{w.recipeKey}</div>);
    const { unmount } = render(<RecipeLibrary orgId={ORG} renderStart={renderStart} />);
    fireEvent.click(await screen.findByTestId('recipe-start-identity_offboarding'));
    await waitFor(() => expect(window.location.hash).toBe('#tab=library&recipe=identity_offboarding'));
    expect(await screen.findByTestId('start-panel')).toHaveTextContent('identity_offboarding');
    unmount();

    // A deep link lands on the same selection.
    render(<RecipeLibrary orgId={ORG} renderStart={renderStart} />);
    expect(await screen.findByTestId('start-panel')).toBeInTheDocument();
  });

  it('does not open the start panel for an unavailable recipe even from a deep link', async () => {
    window.location.hash = 'recipe=identity_offboarding';
    fetchMock.mockImplementation(async () => json({ data: [workflow({ readiness: "unavailable" })] }));
    render(<RecipeLibrary orgId={ORG} renderStart={() => <div data-testid="start-panel" />} />);
    expect(await screen.findByTestId('recipe-card-identity_offboarding')).toBeInTheDocument();
    expect(screen.queryByTestId('start-panel')).not.toBeInTheDocument();
  });

  it('shows a 4xx refusal\'s own reason and no Retry that could never succeed', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'Organization not found' }, 404));
    render(<RecipeLibrary orgId={ORG} />);
    expect(await screen.findByTestId('recipe-library-error')).toHaveTextContent('Organization not found');
    expect(screen.queryByTestId('recipe-library-retry')).toBeNull();
  });

  it('a refresh (after "allow tools") keeps an open start form mounted, with what was typed', async () => {
    const AGENT = '22222222-2222-4222-8222-222222222222';
    window.location.hash = 'recipe=identity_offboarding';
    const wf = workflow({
      readiness: 'setup_required',
      agentId: AGENT,
      missingCapabilities: [{
        key: 'agent.tools', kind: 'agent_tool', provider: 'google', detail: 'Tools missing.', degradesToHumanWork: true,
        availability: 'tenant_fixable', action: { kind: 'add_agent_tools', href: null, toolNames: ['google_suspend_user'], agentId: AGENT },
      }],
    });
    // The refresh is held open, so the test observes the in-flight window a
    // real network leaves (an instant mock lets React batch it away).
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let workflowReads = 0;
    fetchMock.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.startsWith('/ai/operator/workflows')) {
        workflowReads += 1;
        if (workflowReads > 1) await held;
        return json({ data: [wf] });
      }
      if (u === `/ai/agents/${AGENT}` && init?.method === 'PATCH') return json({ data: { id: AGENT } });
      if (u === `/ai/agents/${AGENT}`) return json({ data: { id: AGENT, name: 'Helpdesk', allOrgs: false, toolAllowlist: [] } });
      return json({ error: 'unexpected' }, 404);
    });
    render(<RecipeLibrary orgId={ORG} renderStart={() => <input data-testid="typed" defaultValue="" />} />);
    const typed = await screen.findByTestId('typed') as HTMLInputElement;
    fireEvent.change(typed, { target: { value: 'half-filled form' } });
    const allow = await screen.findByTestId('recipe-missing-action-agent.tools');
    await waitFor(() => expect(allow).toHaveTextContent('Helpdesk'));
    fireEvent.click(allow);
    await waitFor(() => expect(workflowReads).toBe(2));
    // While the refresh is in flight: no skeleton, the form and its input survive.
    expect(screen.queryByTestId('recipe-library-loading')).toBeNull();
    expect((screen.getByTestId('typed') as HTMLInputElement).value).toBe('half-filled form');
    await act(async () => { release(); });
    expect((screen.getByTestId('typed') as HTMLInputElement).value).toBe('half-filled form');
  });
});
