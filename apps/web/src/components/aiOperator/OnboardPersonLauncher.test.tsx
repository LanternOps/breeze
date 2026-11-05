import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));

import { fetchWithAuth } from '../../stores/auth';
import { useFeaturesStore } from '../../stores/featuresStore';
import OnboardPersonLauncher from './OnboardPersonLauncher';

const fetchMock = vi.mocked(fetchWithAuth);
const ORG = '11111111-1111-4111-8111-111111111111';
const REQUESTER = '33333333-3333-4333-8333-333333333333';

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

const workflow = (recipeKey: string, readiness: string) => ({
  recipeKey, recipeVersion: 3, name: recipeKey, summary: 's',
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
    if (url.startsWith(`/orgs/organizations/${ORG}/contacts`)) {
      return json({ data: [{ id: REQUESTER, name: 'Morgan Manager', email: 'morgan@customer.example', phone: null, siteId: null }], pagination: { total: 1 } });
    }
    if (url.startsWith('/orgs/sites')) return json({ data: [] });
    return json({ error: 'unexpected' }, 404);
  });
}

const workflowFetches = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/ai/operator/workflows')).length;

beforeEach(() => {
  fetchMock.mockReset();
  useFeaturesStore.setState({
    features: { billing: false, support: false, aiOperatorTasks: false, aiAgentsSweepAct: false, aiAgentsPolicyDecide: false, toolSources: false, flows: false, preAssignmentEnrollment: false, callerVerification: false, sendingDomains: false },
    loaded: false,
  });
});
afterEach(() => vi.clearAllMocks());

async function settle() {
  await waitFor(() => expect(workflowFetches()).toBe(1));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('OnboardPersonLauncher', () => {
  it('is hidden, and reads no Library, when the server flag is off', async () => {
    routes({ flag: false, workflows: [workflow('identity_onboarding', 'ready')] });
    const { container } = render(<OnboardPersonLauncher orgId={ORG} source="org" />);
    await waitFor(() => expect(useFeaturesStore.getState().loaded).toBe(true));
    expect(container).toBeEmptyDOMElement();
    expect(workflowFetches()).toBe(0);
  });

  it('is hidden when /config is unreachable (fails closed)', async () => {
    routes({ flag: 'unreachable', workflows: [workflow('identity_onboarding', 'ready')] });
    const { container } = render(<OnboardPersonLauncher orgId={ORG} source="org" />);
    await waitFor(() => expect(useFeaturesStore.getState().loaded).toBe(true));
    expect(container).toBeEmptyDOMElement();
  });

  it('positive control: the same settle step is enough for a ready recipe to show its launcher', async () => {
    routes({ flag: true, workflows: [workflow('identity_onboarding', 'ready')] });
    render(<OnboardPersonLauncher orgId={ORG} source="org" />);
    await settle();
    expect(screen.getByTestId('launch-onboard-person-org')).toBeInTheDocument();
  });

  it('is hidden when onboarding is unavailable, even if offboarding is ready', async () => {
    routes({ flag: true, workflows: [workflow('identity_onboarding', 'unavailable'), workflow('identity_offboarding', 'ready')] });
    const { container } = render(<OnboardPersonLauncher orgId={ORG} source="org" />);
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('is hidden when the Library has no onboarding recipe at all', async () => {
    routes({ flag: true, workflows: [workflow('identity_offboarding', 'ready')] });
    const { container } = render(<OnboardPersonLauncher orgId={ORG} source="org" />);
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it.each(['ready', 'setup_required'])('from the org: shows on %s and opens the onboarding form with every field empty', async (readiness) => {
    routes({ flag: true, workflows: [workflow('identity_onboarding', readiness)] });
    render(<OnboardPersonLauncher orgId={ORG} source="org" />);
    fireEvent.click(await screen.findByTestId('launch-onboard-person-org'));
    expect(await screen.findByTestId('start-recipe-form')).toHaveAttribute('data-recipe-key', 'identity_onboarding');
    expect((screen.getByTestId('start-recipe-display-name') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('start-recipe-manager') as HTMLSelectElement).value).toBe('');
    expect(screen.queryByTestId('start-recipe-manager-prefill-note')).toBeNull();
  });

  it('from a ticket: the requester becomes the MANAGER, and the new hire\'s name stays empty', async () => {
    routes({ flag: true, workflows: [workflow('identity_onboarding', 'ready')] });
    render(<OnboardPersonLauncher orgId={ORG} source="ticket" requesterContactId={REQUESTER} requesterLabel="Morgan Manager" />);
    fireEvent.click(await screen.findByTestId('launch-onboard-person-ticket'));
    expect(await screen.findByTestId('start-recipe-form')).toHaveAttribute('data-recipe-key', 'identity_onboarding');
    expect((screen.getByTestId('start-recipe-display-name') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('start-recipe-manager-prefill-note')).toHaveTextContent('its requester is set as the manager, not as the new person');
    await waitFor(() => expect((screen.getByTestId('start-recipe-manager') as HTMLSelectElement).value).toBe(REQUESTER));
  });

  it('from a ticket with no requester contact: no manager is guessed', async () => {
    routes({ flag: true, workflows: [workflow('identity_onboarding', 'ready')] });
    render(<OnboardPersonLauncher orgId={ORG} source="ticket" requesterContactId={null} requesterLabel="someone@customer.example" />);
    fireEvent.click(await screen.findByTestId('launch-onboard-person-ticket'));
    await screen.findByTestId('start-recipe-form');
    expect((screen.getByTestId('start-recipe-manager') as HTMLSelectElement).value).toBe('');
    expect(screen.queryByTestId('start-recipe-manager-prefill-note')).toBeNull();
  });
});
