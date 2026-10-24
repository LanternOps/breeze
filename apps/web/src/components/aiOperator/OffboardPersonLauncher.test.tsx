import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));

import { fetchWithAuth } from '../../stores/auth';
import { useFeaturesStore } from '../../stores/featuresStore';
import OffboardPersonLauncher from './OffboardPersonLauncher';

const fetchMock = vi.mocked(fetchWithAuth);
const ORG = '11111111-1111-4111-8111-111111111111';
const CONTACT = '33333333-3333-4333-8333-333333333333';

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

const workflow = (readiness: string) => ({
  recipeKey: 'identity_offboarding', recipeVersion: 3, name: 'Offboard a person', summary: 's',
  gateClass: 'deterministic', targetKinds: ['contact'], readiness, missingCapabilities: [],
  alwaysManualCapabilities: [], manualStepCount: 0, degradedEffects: [], agentId: null, agentKind: 'helpdesk',
});

function routes(opts: { flag: boolean | 'unreachable'; workflows?: unknown[] }) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/config') {
      return opts.flag === 'unreachable' ? json({}, 500) : json({ features: { aiOperatorTasks: opts.flag } });
    }
    if (url.startsWith('/ai/operator/workflows')) return json({ data: opts.workflows ?? [] });
    if (url.startsWith('/devices')) return json({ data: [] });
    return json({ error: 'unexpected' }, 404);
  });
}

const workflowFetches = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/ai/operator/workflows')).length;

beforeEach(() => {
  fetchMock.mockReset();
  useFeaturesStore.setState({
    features: { billing: false, support: false, aiOperatorTasks: false, aiAgentsSweepAct: false, toolSources: false, flows: false, preAssignmentEnrollment: false, callerVerification: false },
    loaded: false,
  });
});
afterEach(() => vi.clearAllMocks());

describe('OffboardPersonLauncher', () => {
  it('is hidden, and reads no Library, when the server flag is off', async () => {
    routes({ flag: false, workflows: [workflow('ready')] });
    const { container } = render(<OffboardPersonLauncher orgId={ORG} source="contact" contactId={CONTACT} label="Dana" />);
    await waitFor(() => expect(useFeaturesStore.getState().loaded).toBe(true));
    expect(container).toBeEmptyDOMElement();
    expect(workflowFetches()).toBe(0);
  });

  it('is hidden when /config is unreachable (fails closed)', async () => {
    routes({ flag: 'unreachable', workflows: [workflow('ready')] });
    const { container } = render(<OffboardPersonLauncher orgId={ORG} source="contact" contactId={CONTACT} label="Dana" />);
    await waitFor(() => expect(useFeaturesStore.getState().loaded).toBe(true));
    expect(container).toBeEmptyDOMElement();
  });

  it('is hidden when the recipe is unavailable (what the identity flag being off produces)', async () => {
    routes({ flag: true, workflows: [workflow('unavailable')] });
    const { container } = render(<OffboardPersonLauncher orgId={ORG} source="contact" contactId={CONTACT} label="Dana" />);
    await waitFor(() => expect(workflowFetches()).toBe(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('is hidden when the Library has no offboarding recipe at all', async () => {
    routes({ flag: true, workflows: [] });
    const { container } = render(<OffboardPersonLauncher orgId={ORG} source="contact" contactId={CONTACT} label="Dana" />);
    await waitFor(() => expect(workflowFetches()).toBe(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it.each(['ready', 'setup_required'])('shows on %s and opens the form with the context', async (readiness) => {
    routes({ flag: true, workflows: [workflow(readiness)] });
    render(<OffboardPersonLauncher orgId={ORG} source="contact" contactId={CONTACT} label="Dana Smith" />);
    fireEvent.click(await screen.findByTestId('offboard-launcher-contact'));
    expect(await screen.findByTestId('start-recipe-form')).toBeInTheDocument();
    expect(screen.getByTestId('start-recipe-person')).toHaveTextContent('Dana Smith');
    expect(screen.queryByTestId('start-recipe-person-hint')).toBeNull();
  });
});
