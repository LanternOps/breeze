import '@/lib/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { fetchMock, toastMock, userState, orgState } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: vi.fn(),
  userState: { id: 'user-me' as string },
  orgState: {
    organizations: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Acme', status: 'active' },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Initech', status: 'active' },
      { id: 'pool', name: 'Unassigned', status: 'active', type: 'unassigned_pool' },
    ],
    fetchOrganizations: vi.fn(async () => undefined),
  },
}));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchMock,
  useAuthStore: (selector: (s: { user: { id: string } }) => unknown) => selector({ user: { id: userState.id } }),
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: typeof orgState) => unknown) => selector(orgState),
}));
vi.mock('../shared/Toast', () => ({ showToast: toastMock }));

import MappingsStep, { defaultPriority } from './MappingsStep';
import { ORG_A, ORG_B, SOURCE_ID, json, preflight, sourceDetail } from './testFixtures';

const CATEGORY = '66666666-6666-4666-8666-666666666666';

function route(put: () => Response = () => json(200, { data: {} })) {
  fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url === '/ticket-categories') return json(200, { data: [{ id: CATEGORY, name: 'Hardware' }, { id: 'x', name: 'Old', isActive: false }] });
    if (url === `/ticket-imports/sources/${SOURCE_ID}/mappings` && init?.method === 'PUT') return put();
    if (url === `/ticket-imports/sources/${SOURCE_ID}/preflight` && init?.method === 'POST') return json(200, { data: preflight() });
    return json(404, { error: 'unrouted' });
  });
}
const putBody = () => {
  const call = fetchMock.mock.calls.find(([, init]) => (init as { method?: string })?.method === 'PUT');
  return call ? JSON.parse((call[1] as { body: string }).body) : null;
};

beforeEach(() => {
  vi.clearAllMocks();
  userState.id = 'user-me';
});

describe('defaultPriority (#8313 W6)', () => {
  it('follows the module default: the seeded names, anything else normal', () => {
    expect(defaultPriority('1 low')).toBe('low');
    expect(defaultPriority('2 normal')).toBe('normal');
    expect(defaultPriority('3 high')).toBe('high');
    expect(defaultPriority('VIP')).toBe('normal');
  });
});

describe('MappingsStep (#8313 W6)', () => {
  it('suggests orgs by exact name, then saves the maps, the fallback and the options with contacts off by default', async () => {
    route();
    const onSaved = vi.fn();
    const onContinue = vi.fn();
    render(<MappingsStep source={sourceDetail()} preflight={preflight()} onPreflight={vi.fn()} onSaved={onSaved} onContinue={onContinue} />);
    // Acme matches by name; Globex has no Breeze org and stays skipped.
    expect(screen.getByTestId('ticket-import-mappings-org-1')).toHaveValue(ORG_A);
    expect(screen.getByTestId('ticket-import-mappings-org-2')).toHaveValue('');
    // The unassigned pool is never offered.
    expect([...screen.getByTestId('ticket-import-mappings-fallback').querySelectorAll('option')].map((o) => o.textContent)).toEqual(['No fallback', 'Acme', 'Initech']);
    expect(screen.getByTestId('ticket-import-mappings-create-contacts')).not.toBeChecked();
    expect(screen.queryByTestId('ticket-import-mappings-updated-since')).toBeNull();

    fireEvent.change(screen.getByTestId('ticket-import-mappings-fallback'), { target: { value: ORG_B } });
    await waitFor(() => expect(screen.getByTestId('ticket-import-mappings-group-10').querySelectorAll('option')).toHaveLength(2));
    fireEvent.change(screen.getByTestId('ticket-import-mappings-group-10'), { target: { value: CATEGORY } });
    fireEvent.change(screen.getByTestId('ticket-import-mappings-priority-4'), { target: { value: 'urgent' } });
    fireEvent.change(screen.getByTestId('ticket-import-mappings-state-9'), { target: { value: 'pending' } });
    fireEvent.click(screen.getByTestId('ticket-import-mappings-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onContinue).toHaveBeenCalled();

    expect(putBody()).toEqual({
      orgs: [
        { sourceOrgKey: '1', sourceOrgName: 'Acme', orgId: ORG_A },
        { sourceOrgKey: null, sourceOrgName: null, orgId: ORG_B },
      ],
      categories: [{ sourceGroupKey: '10', sourceGroupName: 'Support', categoryId: CATEGORY }],
      options: {
        priorityMap: { 1: 'low', 2: 'normal', 3: 'high', 4: 'urgent' },
        stateMap: { 9: { status: 'pending', name: 'waiting (open)' } },
        systemArticles: 'skip',
        timeAccountingNote: true,
        timeUnitLabel: 'minutes',
        createRequesterContacts: false,
      },
    });
  });

  it('sends "Create missing requester contacts" with its "updated since" date only when on', async () => {
    route();
    render(<MappingsStep source={sourceDetail()} preflight={preflight()} onPreflight={vi.fn()} onSaved={vi.fn()} onContinue={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ticket-import-mappings-create-contacts'));
    fireEvent.change(screen.getByTestId('ticket-import-mappings-updated-since'), { target: { value: '2025-01-01' } });
    fireEvent.click(screen.getByTestId('ticket-import-mappings-save'));
    await waitFor(() => expect(putBody()).not.toBeNull());
    expect(putBody().options).toMatchObject({ createRequesterContacts: true, createRequesterContactsUpdatedSince: '2025-01-01' });

    fetchMock.mockClear();
    fireEvent.click(screen.getByTestId('ticket-import-mappings-create-contacts'));
    fireEvent.click(screen.getByTestId('ticket-import-mappings-save'));
    await waitFor(() => expect(putBody()).not.toBeNull());
    expect(putBody().options.createRequesterContacts).toBe(false);
    expect(putBody().options).not.toHaveProperty('createRequesterContactsUpdatedSince');
  });

  it('keeps saved mappings and options instead of suggesting', () => {
    route();
    render(<MappingsStep
      source={sourceDetail({
        options: { createRequesterContacts: true, createRequesterContactsUpdatedSince: '2024-06-01', priorityMap: { 4: 'high' }, systemArticles: 'internal_note' },
        mappings: { orgs: [{ sourceOrgKey: '2', sourceOrgName: 'Globex', orgId: ORG_B }], categories: [] },
      })}
      preflight={preflight()} onPreflight={vi.fn()} onSaved={vi.fn()} onContinue={vi.fn()} />);
    expect(screen.getByTestId('ticket-import-mappings-org-1')).toHaveValue('');
    expect(screen.getByTestId('ticket-import-mappings-org-2')).toHaveValue(ORG_B);
    expect(screen.getByTestId('ticket-import-mappings-priority-4')).toHaveValue('high');
    expect(screen.getByTestId('ticket-import-mappings-create-contacts')).toBeChecked();
    expect(screen.getByTestId('ticket-import-mappings-updated-since')).toHaveValue('2024-06-01');
    expect(screen.getByTestId('ticket-import-mappings-system-articles')).toHaveValue('internal_note');
  });

  it('is read-only for a non-owner and while a run is active', () => {
    route();
    userState.id = 'someone-else';
    const { unmount } = render(<MappingsStep source={sourceDetail()} preflight={preflight()} onPreflight={vi.fn()} onSaved={vi.fn()} onContinue={vi.fn()} />);
    expect(screen.getByTestId('ticket-import-mappings-not-owner')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-import-mappings-save')).toBeDisabled();
    unmount();
    userState.id = 'user-me';
    render(<MappingsStep source={sourceDetail({ activeRunId: 'run-1' })} preflight={preflight()} onPreflight={vi.fn()} onSaved={vi.fn()} onContinue={vi.fn()} />);
    expect(screen.getByTestId('ticket-import-mappings-locked')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-import-mappings-save')).toBeDisabled();
  });

  it('without a catalog, runs the preflight to load one', async () => {
    route();
    const onPreflight = vi.fn();
    render(<MappingsStep source={sourceDetail()} preflight={null} onPreflight={onPreflight} onSaved={vi.fn()} onContinue={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ticket-import-mappings-load'));
    await waitFor(() => expect(onPreflight).toHaveBeenCalledWith(expect.objectContaining({ objectStorage: { configured: true } })));
  });

  it('a save refused while a run started meanwhile says why', async () => {
    route(() => json(409, { error: 'locked', code: 'TICKET_IMPORT_MAPPING_LOCKED' }));
    const onSaved = vi.fn();
    render(<MappingsStep source={sourceDetail()} preflight={preflight()} onPreflight={vi.fn()} onSaved={onSaved} onContinue={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ticket-import-mappings-save'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: 'The mappings are locked while a run is in progress.',
    })));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('keeps a saved map of an org the source no longer lists, unless removed', async () => {
    route();
    const gone = { sourceOrgKey: '99', sourceOrgName: 'Old Customer', orgId: ORG_A };
    const { unmount } = render(<MappingsStep source={sourceDetail({ mappings: { orgs: [gone], categories: [] } })}
      preflight={preflight()} onPreflight={vi.fn()} onSaved={vi.fn()} onContinue={vi.fn()} />);
    expect(screen.getByTestId('ticket-import-mappings-gone-orgs')).toHaveTextContent('Old Customer (no longer in the source)');
    expect(screen.getByTestId('ticket-import-mappings-org-99')).toHaveValue(ORG_A);
    fireEvent.click(screen.getByTestId('ticket-import-mappings-save'));
    await waitFor(() => expect(putBody()).not.toBeNull());
    expect(putBody().orgs).toContainEqual(gone);
    unmount();

    fetchMock.mockClear();
    render(<MappingsStep source={sourceDetail({ mappings: { orgs: [gone], categories: [] } })}
      preflight={preflight()} onPreflight={vi.fn()} onSaved={vi.fn()} onContinue={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ticket-import-mappings-org-99'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('ticket-import-mappings-save'));
    await waitFor(() => expect(putBody()).not.toBeNull());
    expect(putBody().orgs.some((o: { sourceOrgKey: string | null }) => o.sourceOrgKey === '99')).toBe(false);
  });
});
