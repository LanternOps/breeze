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
});
