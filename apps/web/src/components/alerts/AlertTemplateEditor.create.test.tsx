import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AlertTemplateEditor from './AlertTemplateEditor';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
// Partner scope is detected from the JWT claims, NOT from useOrgStore().partners
// (that array is system-scope-only and is always [] for a real partner user — #1425).
// Hoisted vi.fn so each test can override scope; default is partner-scope.
const { getJwtClaimsMock } = vi.hoisted(() => ({
  getJwtClaimsMock: vi.fn<() => { scope: 'system' | 'partner' | 'organization' | null; partnerId: string | null; orgId: string | null }>(
    () => ({ scope: 'partner', partnerId: 'p-1', orgId: null })
  ),
}));
vi.mock('@/lib/authScope', async () => {
  const actual = await vi.importActual<typeof import('@/lib/authScope')>('@/lib/authScope');
  return { ...actual, getJwtClaims: getJwtClaimsMock };
});
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: () => ({
    // partners is empty for a real partner-scope user (403 on /orgs/partners).
    partners: [],
    organizations: [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Beta' }],
  }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const navMock = vi.mocked(navigateTo);
const json = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('AlertTemplateEditor — create mode (#1425)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to partner-scope default so the existing tests pass unchanged.
    getJwtClaimsMock.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input === '/alert-templates/templates' && opts?.method === 'POST') {
        return json({ data: { id: 'new-1', orgId: null, partnerId: 'p-1' } });
      }
      return json({ data: [] });
    });
  });

  it('shows the partner-wide availability picker for a partner-scope creator', async () => {
    render(<AlertTemplateEditor templateId="new" />);
    await waitFor(() => expect(screen.getByTestId('template-availability')).toBeInTheDocument());
    expect(screen.getByTestId('availability-partner')).toBeChecked();
    // No GET for a template id — new templates don't load.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).match(/\/alert-templates\/templates\/[^?]/))).toBe(false);
  });

  it('POSTs a partner-wide template (availability:partner) and returns to the list', async () => {
    render(<AlertTemplateEditor templateId="new" />);
    await waitFor(() => expect(screen.getByTestId('template-availability')).toBeInTheDocument());

    // The Name field is the first text input in the metadata card.
    const nameInput = screen.getAllByRole('textbox')[0] as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'My New Template' } });

    fireEvent.click(screen.getByText('Create template'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => c[0] === '/alert-templates/templates' && (c[1] as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.availability).toBe('partner');
      expect(body.name).toBe('My New Template');
    });
    expect(navMock).toHaveBeenCalledWith('/settings/alert-templates');
  });

  it('switches to a specific org and sends orgId', async () => {
    render(<AlertTemplateEditor templateId="new" />);
    await waitFor(() => expect(screen.getByTestId('template-availability')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('availability-org'));
    fireEvent.change(screen.getByTestId('availability-org-select'), { target: { value: 'org-2' } });
    const nameInput = screen.getAllByRole('textbox')[0] as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Org Scoped' } });
    fireEvent.click(screen.getByText('Create template'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => c[0] === '/alert-templates/templates' && (c[1] as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.availability).toBe('org');
      expect(body.orgId).toBe('org-2');
    });
  });

  it('hides the availability picker for an org-scope creator', async () => {
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', partnerId: null, orgId: 'org-1' });
    render(<AlertTemplateEditor templateId="new" />);
    // Wait for first paint via an always-present anchor before asserting absence.
    await screen.findByText('Create template');
    expect(screen.queryByTestId('template-availability')).not.toBeInTheDocument();
  });

  it('hides the availability picker for a partner-scope creator with no partnerId', async () => {
    // Guards the `&& !!partnerId` half of the gate (organizations length still > 1).
    getJwtClaimsMock.mockReturnValue({ scope: 'partner', partnerId: null, orgId: null });
    render(<AlertTemplateEditor templateId="new" />);
    await screen.findByText('Create template');
    expect(screen.queryByTestId('template-availability')).not.toBeInTheDocument();
  });

  it('omits availability from the POST body for an org-scope creator', async () => {
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', partnerId: null, orgId: 'org-1' });
    render(<AlertTemplateEditor templateId="new" />);
    await screen.findByText('Create template');

    const nameInput = screen.getAllByRole('textbox')[0] as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Org User Template' } });
    fireEvent.click(screen.getByText('Create template'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => c[0] === '/alert-templates/templates' && (c[1] as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect('availability' in body).toBe(false);
      expect(body.name).toBe('Org User Template');
    });
  });
});
