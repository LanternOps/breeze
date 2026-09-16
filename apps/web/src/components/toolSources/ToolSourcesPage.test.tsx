/**
 * Tool catalog W01 PR C (#5216) — the list page.
 *
 * The behaviours worth pinning are the two failure-adjacent ones: a failed
 * LIST must say so rather than render as "you have no tool sources" (an empty
 * state is a claim about the tenant, not about the request), and creating a
 * source must land on its detail page — a freshly created source has a
 * discovery job queued and nothing to show in the list yet.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const api = vi.hoisted(() => ({
  listToolSources: vi.fn(),
  createToolSource: vi.fn(),
  updateToolSource: vi.fn(),
}));
vi.mock('./api', () => api);
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (selector: (s: { user: { canManagePartnerWide: boolean } }) => unknown) =>
    selector({ user: { canManagePartnerWide: true } }),
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null }) => unknown) => selector({ currentOrgId: 'org-1' }),
}));
vi.mock('../../hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({ isPartnerScope: true, defaultOwnerScope: 'partner' }),
}));

import ToolSourcesPage from './ToolSourcesPage';

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: 's-1',
    orgId: null,
    partnerId: 'p-1',
    slug: 'hudu',
    name: 'Hudu',
    kind: 'mcp',
    endpointUrl: 'https://hudu.example.test/mcp',
    credentialOrigin: 'https://hudu.example.test',
    authKind: 'bearer',
    hasCredential: true,
    status: 'active',
    lastDiscoveredAt: '2026-10-16T00:00:00.000Z',
    lastError: null,
    rateLimitPerMinute: 120,
    toolCount: 4,
    enabledToolCount: 2,
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listToolSources.mockResolvedValue([source()]);
  api.createToolSource.mockResolvedValue(source({ id: 's-new' }));
});

describe('ToolSourcesPage', () => {
  it('lists sources with their scope badge and enabled/total counts', async () => {
    render(<ToolSourcesPage />);
    await screen.findByTestId('tool-source-row-s-1');
    // ResponsiveTable renders the desktop table AND the mobile cards, so the
    // shared ScopeBadge id legitimately appears once per surface.
    expect(screen.getAllByTestId('scope-badge').length).toBeGreaterThan(0);
    expect(screen.getByTestId('tool-source-row-s-1').textContent).toContain('2');
    expect(screen.getByTestId('tool-source-row-s-1').textContent).toContain('4');
    expect(screen.queryByTestId('tool-sources-empty')).toBeNull();
  });

  it('shows the empty state only when the tenant genuinely has none', async () => {
    api.listToolSources.mockResolvedValue([]);
    render(<ToolSourcesPage />);
    expect(await screen.findByTestId('tool-sources-empty')).toBeTruthy();
    expect(screen.queryByTestId('tool-sources-error')).toBeNull();
  });

  it('a FAILED load says so instead of claiming the tenant has no sources', async () => {
    api.listToolSources.mockRejectedValue(new Error('network'));
    render(<ToolSourcesPage />);
    expect(await screen.findByTestId('tool-sources-error')).toBeTruthy();
    expect(screen.queryByTestId('tool-sources-empty')).toBeNull();
  });

  it('creating a source navigates to its detail page, where discovery becomes visible', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { get href() { return ''; }, set href(v: string) { assign(v); } },
    });

    render(<ToolSourcesPage />);
    await screen.findByTestId('tool-source-row-s-1');
    await user.click(screen.getByTestId('tool-sources-add'));

    await user.type(screen.getByTestId('tool-source-name'), 'Hudu');
    await user.type(screen.getByTestId('tool-source-endpoint'), 'https://hudu.example.test/mcp');
    await user.click(screen.getByTestId('tool-source-submit'));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/settings/tool-sources/s-new'));
  });
});
