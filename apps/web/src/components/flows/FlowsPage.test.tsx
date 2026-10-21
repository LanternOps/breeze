/**
 * Tool Catalog W3 (#5218) PR B — the read-only Flows list.
 *
 * Pinned behaviours: partner-wide rows carry the shared "All orgs" ScopeBadge,
 * a FAILED load says so rather than claiming the tenant has no flows, the
 * preview notice is always visible, and a deployment with the flag off renders
 * the not-found state without ever calling the API.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ listFlows: vi.fn(), getFlow: vi.fn() }));
vi.mock('./api', () => api);
const gate = vi.hoisted(() => ({ value: { enabled: true, loaded: true } }));
vi.mock('../../stores/featuresStore', () => ({ useFlowsGate: () => gate.value }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import FlowsPage from './FlowsPage';

function flow(overrides: Record<string, unknown> = {}) {
  return {
    id: '9f1c0f4e-0000-4000-8000-000000000001',
    slug: 'nightly_offline',
    name: 'Nightly offline report',
    ownerScope: 'organization',
    orgId: 'org-1',
    partnerId: null,
    status: 'draft',
    effectiveTier: 1,
    triggerType: 'schedule',
    definitionVersion: 1,
    updatedAt: '2026-10-20T02:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  gate.value = { enabled: true, loaded: true };
  api.listFlows.mockResolvedValue({ flows: [flow()], total: 1 });
});

describe('FlowsPage', () => {
  it('renders rows linking to the detail page, with the read-only notice', async () => {
    render(<FlowsPage />);
    const row = await screen.findByTestId('flow-row-9f1c0f4e-0000-4000-8000-000000000001');
    expect(row.textContent).toContain('Nightly offline report');
    expect(row.querySelector('a')?.getAttribute('href')).toBe('/flows/9f1c0f4e-0000-4000-8000-000000000001');
    expect(screen.getByTestId('flow-preview-notice')).toBeTruthy();
    expect(screen.queryByTestId('flow-empty')).toBeNull();
  });

  it('shows the shared partner-wide ("All orgs") scope badge for a partner-wide flow', async () => {
    api.listFlows.mockResolvedValue({
      flows: [flow({ id: 'f-partner', ownerScope: 'partner', orgId: null, partnerId: 'p-1' })],
      total: 1,
    });
    render(<FlowsPage />);
    await screen.findByTestId('flow-row-f-partner');
    const badges = screen.getAllByTestId('scope-badge');
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0].textContent).toMatch(/partner-wide/i);
  });

  it('shows the empty state only when the tenant genuinely has none', async () => {
    api.listFlows.mockResolvedValue({ flows: [], total: 0 });
    render(<FlowsPage />);
    expect(await screen.findByTestId('flow-empty')).toBeTruthy();
    expect(screen.queryByTestId('flow-error')).toBeNull();
  });

  it('a FAILED load says so instead of claiming there are no flows', async () => {
    api.listFlows.mockRejectedValue(new Error('network'));
    render(<FlowsPage />);
    expect(await screen.findByTestId('flow-error')).toBeTruthy();
    expect(screen.queryByTestId('flow-empty')).toBeNull();
  });

  it('renders the not-found state and makes no request when the flag is off', () => {
    gate.value = { enabled: false, loaded: true };
    render(<FlowsPage />);
    expect(screen.getByTestId('flow-not-found')).toBeTruthy();
    expect(api.listFlows).not.toHaveBeenCalled();
  });
});
