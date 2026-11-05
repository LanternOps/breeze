/**
 * MOUNT proof for /operator (W06 R1b Task 18): a previous wave shipped green
 * components that no page ever rendered, so these assert through the component
 * the Astro page mounts, and read the page source for its island directive.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));

import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import OperatorWorkspace from './OperatorWorkspace';

const fetchMock = vi.mocked(fetchWithAuth);
const ORG = '11111111-1111-4111-8111-111111111111';
const here = dirname(fileURLToPath(import.meta.url));

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

const WORKFLOW = {
  recipeKey: 'identity_offboarding', recipeVersion: 3, name: 'Offboard a person', summary: 's',
  gateClass: 'deterministic', targetKinds: ['contact'], readiness: 'ready', missingCapabilities: [],
  alwaysManualCapabilities: [], manualStepCount: 0, degradedEffects: [], agentId: null, agentKind: 'helpdesk',
};

function routeFetches() {
  fetchMock.mockImplementation(async (url) => {
    const u = String(url);
    if (u.startsWith('/ai/operator/workflows')) return json({ data: [WORKFLOW] });
    if (u.startsWith('/ai/operator/tasks')) return json({ data: [], nextCursor: null });
    return json({ error: 'unexpected' }, 404);
  });
}

const workflowCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/ai/operator/workflows')).length;
const taskCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/ai/operator/tasks')).length;

beforeEach(() => {
  fetchMock.mockReset();
  routeFetches();
  window.location.hash = '';
  useOrgStore.setState({ currentOrgId: ORG });
});
afterEach(() => vi.clearAllMocks());

describe('OperatorWorkspace (MOUNT)', () => {
  it('#tab=library renders the offboarding card through the component the page mounts', async () => {
    window.location.hash = 'tab=library';
    render(<OperatorWorkspace />);
    expect(await screen.findByTestId('recipe-card-identity_offboarding')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(`/ai/operator/workflows?orgId=${ORG}`, expect.anything());
  });

  it.each(['', 'tab=tasks'])('hash "%s" renders the task list, not the Library', async (hash) => {
    window.location.hash = hash;
    render(<OperatorWorkspace />);
    expect(await screen.findByTestId('operator-task-list-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('recipe-card-identity_offboarding')).not.toBeInTheDocument();
    expect(workflowCalls()).toBe(0);
  });

  it('switching tabs writes the hash and does not remount (refetch) the other tab', async () => {
    render(<OperatorWorkspace />);
    await screen.findByTestId('operator-task-list-empty');
    fireEvent.click(screen.getByTestId('operator-tab-library'));
    await waitFor(() => expect(window.location.hash).toBe('#tab=library'));
    await screen.findByTestId('recipe-card-identity_offboarding');
    fireEvent.click(screen.getByTestId('operator-tab-tasks'));
    await waitFor(() => expect(window.location.hash).toBe('#tab=tasks'));
    fireEvent.click(screen.getByTestId('operator-tab-library'));
    await act(async () => {});
    expect(screen.getByTestId('recipe-card-identity_offboarding')).toBeVisible();
    expect(workflowCalls()).toBe(1);
    expect(taskCalls()).toBe(1);
  });

  it('starting a recipe from the Library opens the start form in place, deep-linked by #recipe=', async () => {
    window.location.hash = 'tab=library';
    render(<OperatorWorkspace />);
    fireEvent.click(await screen.findByTestId('recipe-start-identity_offboarding'));
    expect(await screen.findByTestId('start-recipe-form')).toBeInTheDocument();
    expect(screen.getByTestId('start-recipe-person-hint')).toBeInTheDocument();
    await waitFor(() => expect(window.location.hash).toBe('#tab=library&recipe=identity_offboarding'));
  });

  it('the Astro page imports the workspace with an island directive', () => {
    const page = readFileSync(join(here, '../../pages/operator/index.astro'), 'utf8');
    expect(page).toContain("import OperatorWorkspace from '../../components/aiOperator/OperatorWorkspace'");
    expect(page).toMatch(/<OperatorWorkspace[^>]*client:load/);
  });
});
