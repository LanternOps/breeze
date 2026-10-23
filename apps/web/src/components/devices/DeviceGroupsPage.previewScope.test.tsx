import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import DeviceGroupsPage from './DeviceGroupsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useCustomFieldDefinitionsStore } from '../../stores/customFieldDefinitions';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

const previewSpy = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useFilterPreview', () => ({
  useFilterPreview: (...args: unknown[]) => {
    previewSpy(...args);
    return { preview: null, loading: false, error: null, refresh: vi.fn() };
  },
}));

const mockFetch = vi.mocked(fetchWithAuth);
const jsonResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

const OTHER_ORG = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  useCustomFieldDefinitionsStore.setState({ definitions: [], status: 'idle' });
  // Explicit All-organizations view: no focused org, so the preview request
  // would otherwise carry no org scope at all (#9262).
  useOrgStore.setState({
    currentOrgId: null,
    allOrgs: true,
    organizations: [
      { id: OTHER_ORG, partnerId: 'p-1', name: 'Second Org', status: 'active', createdAt: '2026-01-01T00:00:00Z' },
    ],
    organizationsLoaded: true,
    error: null,
  });
  mockFetch.mockImplementation(async (url: string) => {
    const path = String(url).split('?')[0];
    if (path === '/device-groups') {
      return jsonResponse({
        data: [
          {
            id: 'group-1',
            orgId: OTHER_ORG,
            name: 'QA Dyn not Macs',
            type: 'dynamic',
            filterConditions: {
              operator: 'AND',
              conditions: [{ field: 'groupId', operator: 'notIn', value: ['g-mac'] }],
            },
          },
        ],
      });
    }
    return jsonResponse({ data: [], pagination: { page: 1, limit: 50, total: 0 } });
  });
});

describe('DeviceGroupsPage dynamic preview scope (#9262)', () => {
  it("pins the edit-form preview to the edited group's own org", async () => {
    const user = userEvent.setup();
    render(<DeviceGroupsPage />);
    await screen.findByText('QA Dyn not Macs');

    await user.click(screen.getByRole('button', { name: 'Edit' }));

    await waitFor(() => {
      const scoped = previewSpy.mock.calls.some(
        ([filter, opts]) => filter !== null && (opts as { orgId?: string })?.orgId === OTHER_ORG,
      );
      expect(scoped).toBe(true);
    });
  });
});
