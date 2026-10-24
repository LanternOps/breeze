import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiOperatorMissingCapabilityDto, AiOperatorWorkflowDto } from '@breeze/shared';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/Toast')>();
  return { ...actual, showToast: (...args: unknown[]) => showToast(...args) };
});

import { fetchWithAuth } from '../../stores/auth';
import RecipeCard from './RecipeCard';

const fetchMock = vi.mocked(fetchWithAuth);
const AGENT = '22222222-2222-4222-8222-222222222222';

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

function cap(overrides: Partial<AiOperatorMissingCapabilityDto> = {}): AiOperatorMissingCapabilityDto {
  return {
    key: 'm365.permissions',
    kind: 'permission_grant',
    provider: 'm365',
    detail: 'The Microsoft 365 connection lacks the offboarding permissions.',
    degradesToHumanWork: true,
    availability: 'tenant_fixable',
    action: { kind: 'reconsent_m365', href: null, toolNames: [], agentId: null },
    ...overrides,
  };
}

const manualCap = (key: string): AiOperatorMissingCapabilityDto => cap({
  key,
  kind: 'tool_source',
  detail: `No API exists for ${key}.`,
  availability: 'always_manual',
  action: { kind: 'none', href: null, toolNames: [], agentId: null },
});

function workflow(overrides: Partial<AiOperatorWorkflowDto> = {}): AiOperatorWorkflowDto {
  return {
    recipeKey: 'identity_offboarding',
    recipeVersion: 3,
    name: 'Offboard a person',
    summary: 'Remove a departing person’s access.',
    gateClass: 'deterministic',
    targetKinds: ['contact'],
    readiness: 'ready',
    missingCapabilities: [],
    alwaysManualCapabilities: [],
    manualStepCount: 0,
    degradedEffects: [],
    agentId: AGENT,
    agentKind: 'helpdesk',
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  showToast.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('RecipeCard readiness chip', () => {
  it.each([
    ['ready', 'Ready'],
    ['setup_required', 'Setup required'],
    ['unavailable', 'Not available'],
  ] as const)('reads %s as "%s" and never as another state', (readiness, label) => {
    render(<RecipeCard workflow={workflow({ readiness })} onStart={vi.fn()} />);
    const chip = screen.getByTestId('recipe-readiness-identity_offboarding');
    expect(chip).toHaveTextContent(label);
    if (readiness !== 'ready') expect(chip).not.toHaveTextContent('Ready');
  });
});

describe('RecipeCard setup vs manual blocks', () => {
  it('shows Ready and "3 steps will be done by hand" together — the normal state of this wave', () => {
    render(<RecipeCard
      workflow={workflow({ readiness: 'ready', manualStepCount: 3, alwaysManualCapabilities: [manualCap('a'), manualCap('b'), manualCap('c')] })}
      onStart={vi.fn()}
    />);
    expect(screen.getByTestId('recipe-readiness-identity_offboarding')).toHaveTextContent('Ready');
    expect(screen.getByTestId('recipe-manual-count-identity_offboarding')).toHaveTextContent('3 steps will be done by hand');
    expect(screen.queryByTestId('recipe-setup-identity_offboarding')).not.toBeInTheDocument();
  });

  it('keeps an always_manual row out of the Setup block and gives it no action', () => {
    render(<RecipeCard
      workflow={workflow({
        readiness: 'setup_required',
        missingCapabilities: [cap()],
        alwaysManualCapabilities: [manualCap('exchange.shared_mailbox')],
        manualStepCount: 1,
      })}
      onStart={vi.fn()}
    />);
    fireEvent.click(screen.getByTestId('recipe-manual-expand-identity_offboarding'));
    const manual = screen.getByTestId('recipe-manual-exchange.shared_mailbox');
    expect(manual).toHaveTextContent('No API exists for exchange.shared_mailbox.');
    expect(manual.querySelector('a, button')).toBeNull();
    const setup = screen.getByTestId('recipe-setup-identity_offboarding');
    expect(setup.contains(manual)).toBe(false);
    // The tenant-fixable row IS inside the Setup block — the two blocks are distinct.
    expect(setup.contains(screen.getByTestId('recipe-missing-m365.permissions'))).toBe(true);
  });

  it('renders a server href as a deep link and builds none itself', () => {
    render(<RecipeCard
      workflow={workflow({
        readiness: 'setup_required',
        missingCapabilities: [
          cap({ key: 'google.workspace.connection', kind: 'provider_connection', provider: 'google', action: { kind: 'connect_google', href: '/integrations#google', toolNames: [], agentId: null } }),
          cap({ key: 'm365.permissions', action: { kind: 'reconsent_m365', href: null, toolNames: [], agentId: null } }),
        ],
      })}
      onStart={vi.fn()}
    />);
    const google = screen.getByTestId('recipe-missing-google.workspace.connection');
    expect(within(google).getByRole('link')).toHaveAttribute('href', '/integrations#google');
    // href null → the instruction in words, no fabricated URL.
    const m365 = screen.getByTestId('recipe-missing-m365.permissions');
    expect(m365.querySelector('a')).toBeNull();
    expect(m365).toHaveTextContent('Grant the updated Microsoft 365 permissions');
  });

  it('lists the degraded effects in their own "done by hand" detail', () => {
    render(<RecipeCard
      workflow={workflow({ degradedEffects: ['m365_disable_user', 'google_suspend_user'] })}
      onStart={vi.fn()}
    />);
    const degraded = screen.getByTestId('recipe-degraded-identity_offboarding');
    expect(degraded).toHaveTextContent('Block Microsoft 365 sign-in');
    expect(degraded).toHaveTextContent('Suspend the Google account');
  });
});

describe('RecipeCard start action', () => {
  it.each(['ready', 'setup_required'] as const)('is enabled on %s (the recipe runs, degraded)', (readiness) => {
    const onStart = vi.fn();
    render(<RecipeCard workflow={workflow({ readiness, missingCapabilities: readiness === 'ready' ? [] : [cap()] })} onStart={onStart} />);
    const start = screen.getByTestId('recipe-start-identity_offboarding');
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('is disabled only on unavailable, with the reason as its tooltip', () => {
    render(<RecipeCard
      workflow={workflow({
        readiness: 'unavailable',
        missingCapabilities: [cap({ key: 'connections', kind: 'provider_connection', degradesToHumanWork: false, detail: 'Neither Microsoft 365 nor Google Workspace is connected.' })],
      })}
      onStart={vi.fn()}
    />);
    const start = screen.getByTestId('recipe-start-identity_offboarding');
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute('title', 'Neither Microsoft 365 nor Google Workspace is connected.');
  });

  it('names the deployment as the reason when the recipe is switched off and reports no gaps', () => {
    render(<RecipeCard workflow={workflow({ readiness: 'unavailable' })} onStart={vi.fn()} />);
    expect(screen.getByTestId('recipe-start-identity_offboarding'))
      .toHaveAttribute('title', 'This recipe is not enabled for this deployment.');
  });
});

describe('RecipeCard add_agent_tools', () => {
  const toolsCap = cap({
    key: 'agent.tools.google',
    kind: 'agent_tool',
    provider: 'google',
    detail: 'The helpdesk agent may not call the Google offboarding tools.',
    action: { kind: 'add_agent_tools', href: null, toolNames: ['google_suspend_user', 'google_signout'], agentId: AGENT },
  });

  it('names the agent it changes, says the change is agent-wide, and sends ONLY the missing tools', async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url) === `/ai/agents/${AGENT}` && (!init?.method || init.method === 'GET')) {
        return json({ data: { id: AGENT, name: 'Front desk', allOrgs: true, toolAllowlist: ['run_script', 'manage_services:restart'] } });
      }
      return json({ data: { id: AGENT } });
    });
    render(<RecipeCard
      workflow={workflow({ readiness: 'setup_required', missingCapabilities: [toolsCap] })}
      onStart={vi.fn()}
      onChanged={onChanged}
    />);
    const button = await screen.findByTestId('recipe-missing-action-agent.tools.google');
    await waitFor(() => expect(button).toHaveTextContent('Allow 2 tools for Front desk'));
    expect(screen.getByTestId('recipe-missing-agent.tools.google'))
      .toHaveTextContent('This changes Front desk everywhere it is used, in every organization it serves');
    fireEvent.click(button);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patch![1]!.body))).toEqual({
      toolAllowlist: ['run_script', 'manage_services:restart', 'google_suspend_user', 'google_signout'],
    });
  });

  it('shows the MFA step-up requirement in the card and in a toast, never swallowing it', async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === 'PATCH') return json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
      return json({ data: { id: AGENT, name: 'Front desk', allOrgs: false, toolAllowlist: [] } });
    });
    render(<RecipeCard workflow={workflow({ readiness: 'setup_required', missingCapabilities: [toolsCap] })} onStart={vi.fn()} />);
    const button = await screen.findByTestId('recipe-missing-action-agent.tools.google');
    await waitFor(() => expect(button).toHaveTextContent('Front desk'));
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId('recipe-missing-error-agent.tools.google')).toHaveTextContent('multi-factor authentication'));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('when the agent cannot be read, words the change at its widest reach rather than understating it', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'Agent not found' }, 404));
    render(<RecipeCard workflow={workflow({ readiness: 'setup_required', missingCapabilities: [toolsCap] })} onStart={vi.fn()} />);
    const scope = screen.getByTestId('recipe-missing-scope-agent.tools.google');
    await waitFor(() => expect(scope).toHaveTextContent('could not read this agent'));
    expect(scope).toHaveTextContent('in every organization it serves');
  });
});
