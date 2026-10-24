/**
 * Tool Catalog W3 (#5218) PR B — read-only flow detail.
 *
 * Pinned: steps render in document order with tier badges, validation issues
 * from the server (e.g. tool_not_found) are surfaced, the selected step lives
 * in the URL hash (`#step-<id>`), and there are no mutation controls at all.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ listFlows: vi.fn(), getFlow: vi.fn() }));
vi.mock('./api', () => api);
const gate = vi.hoisted(() => ({ value: { enabled: true, loaded: true } }));
vi.mock('../../stores/featuresStore', () => ({ useFlowsGate: () => gate.value }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import FlowDetailPage from './FlowDetailPage';

const ID = '9f1c0f4e-0000-4000-8000-000000000001';

function detail() {
  return {
    flow: {
      id: ID,
      slug: 'nightly_offline',
      name: 'Nightly offline report',
      description: 'Lists offline devices',
      ownerScope: 'organization',
      orgId: 'org-1',
      partnerId: null,
      status: 'draft',
      effectiveTier: 2,
      triggerType: 'schedule',
      definitionVersion: 3,
      updatedAt: '2026-10-20T02:00:00.000Z',
      createdAt: '2026-10-19T02:00:00.000Z',
      createdByUserId: 'u-1',
      aiSessionId: 's-1',
      definition: {
        version: 1,
        name: 'Nightly offline report',
        trigger: { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' },
        inputs: [{ name: 'days', type: 'number', required: false }],
        steps: [
          { id: 'list', tool: 'query_devices', input: { status: 'offline' }, approval: 'default', onFailure: 'stop', timeoutSec: 300 },
          { id: 'notify', tool: 'ghost_tool', input: {}, when: 'steps.list.count > 0', approval: 'pre_approved', onFailure: 'continue', timeoutSec: 60 },
        ],
      },
    },
    validation: {
      valid: false,
      effectiveTier: 2,
      steps: [
        { id: 'list', tool: 'query_devices', source: 'core', tier: 1, approval: 'default' },
        { id: 'notify', tool: 'ghost_tool', source: 'tenant', tier: 2, approval: 'pre_approved' },
      ],
      issues: [
        { code: 'tool_not_found', severity: 'error', message: 'Tool ghost_tool was not found', stepId: 'notify' },
        { code: 'input_not_supported', severity: 'warning', message: 'Input ignored', stepId: 'list' },
      ],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '';
  gate.value = { enabled: true, loaded: true };
  api.getFlow.mockResolvedValue(detail());
});

describe('FlowDetailPage', () => {
  it('renders the steps in order with tier badges and the trigger summary', async () => {
    render(<FlowDetailPage flowId={ID} />);
    const list = await screen.findByTestId('flow-steps');
    const items = within(list).getAllByTestId(/^flow-step-(list|notify)$/);
    expect(items.map((el) => el.getAttribute('data-testid'))).toEqual(['flow-step-list', 'flow-step-notify']);
    expect(within(items[0]).getByTestId('flow-step-list-tier').textContent).toContain('1');
    expect(within(items[1]).getByTestId('flow-step-notify-tier').textContent).toContain('2');
    expect(screen.getByTestId('flow-trigger').textContent).toContain('0 2 * * *');
    expect(screen.getByTestId('flow-trigger').textContent).toContain('UTC');
  });

  it('surfaces server validation issues, errors before warnings', async () => {
    render(<FlowDetailPage flowId={ID} />);
    const panel = await screen.findByTestId('flow-issues');
    const issues = within(panel).getAllByTestId(/^flow-issue-/);
    expect(issues[0].getAttribute('data-testid')).toBe('flow-issue-tool_not_found');
    expect(issues[0].textContent).toContain('ghost_tool');
    expect(issues[1].getAttribute('data-testid')).toBe('flow-issue-input_not_supported');
  });

  it('selecting a step writes #step-<id> to the hash', async () => {
    const user = userEvent.setup();
    render(<FlowDetailPage flowId={ID} />);
    await screen.findByTestId('flow-steps');
    await user.click(screen.getByTestId('flow-step-notify-select'));
    expect(window.location.hash).toBe('#step-notify');
    expect(screen.getByTestId('flow-step-notify').getAttribute('aria-current')).toBe('true');
  });

  it('reads the selected step from the hash on load', async () => {
    window.location.hash = '#step-list';
    render(<FlowDetailPage flowId={ID} />);
    await screen.findByTestId('flow-steps');
    expect(screen.getByTestId('flow-step-list').getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('flow-step-notify').getAttribute('aria-current')).toBeNull();
  });

  it('has no enable, edit or delete controls', async () => {
    render(<FlowDetailPage flowId={ID} />);
    await screen.findByTestId('flow-steps');
    const names = screen.queryAllByRole('button').map((b) => (b.textContent ?? '').toLowerCase());
    for (const n of names) expect(n).not.toMatch(/enable|delete|edit|disable|run|save/);
  });

  it('shows the not-found state for a 404', async () => {
    api.getFlow.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    render(<FlowDetailPage flowId={ID} />);
    expect(await screen.findByTestId('flow-not-found')).toBeTruthy();
  });

  it('shows a load error (not not-found) for other failures', async () => {
    api.getFlow.mockRejectedValue(new Error('boom'));
    render(<FlowDetailPage flowId={ID} />);
    expect(await screen.findByTestId('flow-error')).toBeTruthy();
    expect(screen.queryByTestId('flow-not-found')).toBeNull();
  });

  it('renders not-found without requesting when the flag is off', () => {
    gate.value = { enabled: false, loaded: true };
    render(<FlowDetailPage flowId={ID} />);
    expect(screen.getByTestId('flow-not-found')).toBeTruthy();
    expect(api.getFlow).not.toHaveBeenCalled();
  });
});
