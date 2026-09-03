import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable state the mocked hooks/store read from, so each test can vary the
// partner-scope / capability combination this page sees.
const state = vi.hoisted(() => ({
  canManagePartnerWide: undefined as boolean | undefined,
  isPartnerScope: true,
  defaultOwnerScope: 'organization' as 'organization' | 'partner',
  currentOrgId: 'org-1',
  partnerId: 'partner-1',
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { canManagePartnerWide?: boolean } }) => unknown) =>
      selector({ user: { canManagePartnerWide: state.canManagePartnerWide } }),
    { getState: () => ({ tokens: null }) },
  ),
}));

vi.mock('../../hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({
    isPartnerScope: state.isPartnerScope,
    defaultOwnerScope: state.defaultOwnerScope,
  }),
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null }) => unknown) =>
    selector({ currentOrgId: state.currentOrgId }),
}));

vi.mock('../../lib/authScope', () => ({
  getJwtClaims: () => ({ scope: 'partner', orgId: null, partnerId: state.partnerId }),
  loginPathWithNext: () => '/login',
}));

import { fetchWithAuth } from '../../stores/auth';
import CustomFieldsPage from './CustomFieldsPage';

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const PARTNER_WIDE_FIELD = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', orgId: null, partnerId: 'partner-1',
  name: 'Asset Tag', fieldKey: 'asset_tag', type: 'text', options: null,
  required: false, defaultValue: null, deviceTypes: null, scriptWrite: false,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  state.canManagePartnerWide = undefined;
  state.isPartnerScope = true;
  state.defaultOwnerScope = 'organization';
  state.currentOrgId = 'org-1';
  state.partnerId = 'partner-1';
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).startsWith('/custom-fields?')) {
      return jsonResponse({ data: [PARTNER_WIDE_FIELD], total: 1 });
    }
    return jsonResponse({ data: PARTNER_WIDE_FIELD }, 201);
  });
});

describe('CustomFieldsPage partner-wide gating (#2135 step 6)', () => {
  it('badges a partner-wide row as All organizations', async () => {
    render(<CustomFieldsPage />);
    expect(await screen.findByTestId('custom-field-all-orgs-badge')).toBeInTheDocument();
  });

  it('hides Edit and Delete on a partner-wide row from a user who cannot manage partner-wide state', async () => {
    state.canManagePartnerWide = false;
    render(<CustomFieldsPage />);
    await screen.findByTestId('custom-field-all-orgs-badge');
    expect(screen.queryByTestId('custom-field-edit')).toBeNull();
    expect(screen.queryByTestId('custom-field-delete')).toBeNull();
  });

  it('shows Edit and Delete on a partner-wide row to a user who can manage partner-wide state', async () => {
    state.canManagePartnerWide = true;
    render(<CustomFieldsPage />);
    await screen.findByTestId('custom-field-all-orgs-badge');
    expect(screen.getByTestId('custom-field-edit')).toBeInTheDocument();
    expect(screen.getByTestId('custom-field-delete')).toBeInTheDocument();
  });

  it('does not offer the partner-wide owner option to a user who cannot manage it', async () => {
    state.canManagePartnerWide = false;
    render(<CustomFieldsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add custom field/i }));
    expect(screen.queryByTestId('custom-field-owner-partner')).toBeNull();
    expect(screen.queryByTestId('custom-field-owner-org')).toBeNull();
  });

  it('offers both owner options to a partner-scope user who can manage partner-wide state', async () => {
    state.canManagePartnerWide = true;
    render(<CustomFieldsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add custom field/i }));
    expect(screen.getByTestId('custom-field-owner-partner')).toBeInTheDocument();
    expect(screen.getByTestId('custom-field-owner-org')).toBeInTheDocument();
  });

  it('treats an undefined canManagePartnerWide as capable (pre-field session)', async () => {
    state.canManagePartnerWide = undefined;
    render(<CustomFieldsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add custom field/i }));
    expect(screen.getByTestId('custom-field-owner-partner')).toBeInTheDocument();
  });

  // The actual live bug (#3257 Phase 0): a partner-scope tech with
  // orgAccess='selected' (canManagePartnerWide: false) got a 403 from the
  // plain create modal because it never sent an ownership key, defaulting
  // every create to partner-wide. The fix must send an explicit orgId for
  // these users, not fall back to sending nothing.
  it('sends an explicit orgId (not partner-wide) when a non-capable partner-scope user creates a field', async () => {
    state.canManagePartnerWide = false;
    state.currentOrgId = 'org-selected-1';
    render(<CustomFieldsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /add custom field/i }));
    fireEvent.change(await screen.findByPlaceholderText('e.g., Asset Tag'), {
      target: { value: 'Contract Tier' },
    });

    const submit = screen.getByRole('button', { name: /create field/i });
    fireEvent.click(submit);

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(
        ([url, opts]) => url === '/custom-fields' && (opts as RequestInit | undefined)?.method === 'POST',
      );
      expect(createCall).toBeTruthy();
      const body = JSON.parse(String((createCall![1] as RequestInit).body));
      expect(body.orgId).toBe('org-selected-1');
      expect(body.partnerId).toBeUndefined();
    });
  });
});
