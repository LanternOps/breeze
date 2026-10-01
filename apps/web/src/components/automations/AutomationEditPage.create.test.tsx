import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const { getJwtClaimsMock, orgState, formValues } = vi.hoisted(() => ({
  getJwtClaimsMock: vi.fn<() => { scope: 'system' | 'partner' | 'organization' | null; partnerId: string | null; orgId: string | null }>(
    () => ({ scope: 'partner', partnerId: 'p-1', orgId: null }),
  ),
  orgState: {
    current: {
      currentOrgId: 'org-2' as string | null,
      allOrgs: false,
      error: null as string | null,
      organizationsLoaded: true,
      organizations: [
        { id: 'org-1', name: 'Acme' },
        { id: 'org-2', name: 'Globex' },
      ],
    },
  },
  formValues: { current: {} as Record<string, unknown> },
}));

vi.mock('@/lib/authScope', async () => {
  const actual = await vi.importActual<typeof import('@/lib/authScope')>('@/lib/authScope');
  return { ...actual, getJwtClaims: getJwtClaimsMock };
});
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector?: (state: typeof orgState.current) => unknown) =>
    selector ? selector(orgState.current) : orgState.current,
}));
// The real form is covered by AutomationForm.test.tsx; here we only need to
// drive handleSubmit so the assertion is on the POST body that leaves the page.
vi.mock('./AutomationForm', () => ({
  default: ({ onSubmit }: { onSubmit: (v: unknown) => void }) => (
    <button data-testid="fake-submit" onClick={() => onSubmit(formValues.current)}>
      submit
    </button>
  ),
}));

import AutomationEditPage from './AutomationEditPage';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const baseValues = {
  name: 'Nightly cleanup',
  triggerType: 'manual',
  onFailure: 'stop',
  conditions: [],
  actions: [{ type: 'run_script', scriptId: 's1' }],
};

function postBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(
    ([url, init]) => url === '/automations' && (init as RequestInit | undefined)?.method === 'POST',
  )!;
  return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
}

async function submit() {
  render(<AutomationEditPage isNew />);
  fireEvent.click(await screen.findByTestId('fake-submit'));
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'POST')).toBe(true),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(json({ data: [] })));
  getJwtClaimsMock.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
  orgState.current.currentOrgId = 'org-2';
});

describe('AutomationEditPage create — org ownership (multi-org partner)', () => {
  it('sends the selected org in the body for an org-owned automation', async () => {
    formValues.current = { ...baseValues, ownerScope: 'organization' };
    await submit();
    expect(postBody()).toMatchObject({ orgId: 'org-2', enabled: true, ownerScope: 'organization' });
  });

  it('omits orgId for a partner-wide automation', async () => {
    formValues.current = { ...baseValues, ownerScope: 'partner' };
    await submit();
    expect(postBody()).not.toHaveProperty('orgId');
    expect(postBody()).toMatchObject({ ownerScope: 'partner' });
  });

  it('omits orgId when no org is selected (server infers it for org-scoped callers)', async () => {
    orgState.current.currentOrgId = null;
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', partnerId: 'p-1', orgId: 'org-1' });
    formValues.current = { ...baseValues };
    await submit();
    expect(postBody()).not.toHaveProperty('orgId');
  });
});
