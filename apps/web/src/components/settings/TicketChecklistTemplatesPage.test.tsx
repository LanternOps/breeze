import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

// Mutable state the mocked hooks/store read from, mirroring
// DeliverableTemplatesPage.test.tsx so each test can vary the partner-scope /
// capability combination this page sees.
const state = vi.hoisted(() => ({
  canManagePartnerWide: undefined as boolean | undefined,
  isPartnerScope: true,
  defaultOwnerScope: 'organization' as 'organization' | 'partner',
  currentOrgId: 'org-1' as string | null,
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
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

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import TicketChecklistTemplatesPage from './TicketChecklistTemplatesPage';
import type { ChecklistTemplate } from '../../lib/api/ticketChecklistTemplates';

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

function templateFrom(overrides: Partial<ChecklistTemplate> = {}): ChecklistTemplate {
  return {
    id: 'tpl-org',
    orgId: 'org-1',
    partnerId: null,
    ownerScope: 'organization',
    name: 'Laptop refresh',
    description: null,
    instructions: null,
    isActive: true,
    items: [],
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const PARTNER_WIDE = templateFrom({
  id: 'tpl-partner',
  orgId: null,
  partnerId: 'partner-1',
  ownerScope: 'partner',
  name: 'Device onboarding',
});

beforeEach(() => {
  vi.clearAllMocks();
  state.canManagePartnerWide = undefined;
  state.isPartnerScope = true;
  state.defaultOwnerScope = 'organization';
  state.currentOrgId = 'org-1';
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    const method = opts?.method ?? 'GET';
    if (String(url).startsWith('/ticket-checklist-templates') && method === 'GET') {
      return jsonResponse({ data: [PARTNER_WIDE, templateFrom()] });
    }
    return jsonResponse({ error: 'unexpected' }, 500);
  });
});

describe('TicketChecklistTemplatesPage (#5808 W02)', () => {
  it('renders the All orgs badge on a partner-wide template', async () => {
    render(<TicketChecklistTemplatesPage />);
    expect(await screen.findByTestId('checklist-template-all-orgs-badge')).toBeTruthy();
  });

  it('does not render the badge on an org-owned template', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ data: [templateFrom()] }));
    render(<TicketChecklistTemplatesPage />);
    await screen.findByTestId('checklist-template-tpl-org');
    expect(screen.queryByTestId('checklist-template-all-orgs-badge')).toBeNull();
  });

  it('shows the ownerScope selector on CREATE for a partner admin', async () => {
    render(<TicketChecklistTemplatesPage />);
    fireEvent.click(await screen.findByTestId('checklist-template-add'));
    expect(await screen.findByTestId('checklist-template-owner')).toBeTruthy();
  });

  it('hides the selector for a user who fails canManagePartnerWide', async () => {
    state.canManagePartnerWide = false;
    render(<TicketChecklistTemplatesPage />);
    fireEvent.click(await screen.findByTestId('checklist-template-add'));
    await screen.findByTestId('checklist-template-name');
    expect(screen.queryByTestId('checklist-template-owner')).toBeNull();
  });

  it('hides the selector for an org-scope user', async () => {
    state.isPartnerScope = false;
    render(<TicketChecklistTemplatesPage />);
    fireEvent.click(await screen.findByTestId('checklist-template-add'));
    await screen.findByTestId('checklist-template-name');
    expect(screen.queryByTestId('checklist-template-owner')).toBeNull();
  });

  it('does NOT show the selector when EDITING an existing template', async () => {
    // Ownership is create-only. A visible selector on edit would promise a
    // re-homing the API refuses with a 400.
    render(<TicketChecklistTemplatesPage />);
    fireEvent.click(await screen.findByTestId('checklist-template-edit-tpl-org'));
    await screen.findByTestId('checklist-template-name');
    expect(screen.queryByTestId('checklist-template-owner')).toBeNull();
  });

  it('labels the instructions field as internal-only', async () => {
    render(<TicketChecklistTemplatesPage />);
    fireEvent.click(await screen.findByTestId('checklist-template-add'));
    expect(
      (await screen.findByTestId('checklist-template-instructions-hint')).textContent,
    ).toMatch(/never shown to the customer/i);
  });

  it('POSTs ownerScope partner when the partner option is chosen', async () => {
    render(<TicketChecklistTemplatesPage />);
    fireEvent.click(await screen.findByTestId('checklist-template-add'));
    fireEvent.change(await screen.findByTestId('checklist-template-name'), {
      target: { value: 'Offboarding' },
    });
    fireEvent.click(screen.getByTestId('checklist-template-owner-partner'));
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ data: templateFrom({ id: 'tpl-new', orgId: null, ownerScope: 'partner' }) }),
    );
    fireEvent.click(screen.getByTestId('checklist-template-submit'));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, o]) => (o as RequestInit | undefined)?.method === 'POST');
      expect(call).toBeDefined();
      const body = JSON.parse(String((call![1] as RequestInit).body));
      expect(body.ownerScope).toBe('partner');
      // No orgId is sent for a partner-wide template — org_id must stay NULL.
      expect(body.orgId).toBeUndefined();
    });
  });

  it('PATCH never carries ownerScope — ownership is create-only', async () => {
    render(<TicketChecklistTemplatesPage />);
    fireEvent.click(await screen.findByTestId('checklist-template-edit-tpl-org'));
    fireEvent.change(await screen.findByTestId('checklist-template-name'), {
      target: { value: 'Renamed' },
    });
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ data: templateFrom({ name: 'Renamed' }) }),
    );
    fireEvent.click(screen.getByTestId('checklist-template-submit'));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, o]) => (o as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String((call![1] as RequestInit).body));
      expect(body).not.toHaveProperty('ownerScope');
      expect(body).not.toHaveProperty('orgId');
    });
  });

  it('hides edit and delete on a partner-wide template for a non-admin', async () => {
    state.canManagePartnerWide = false;
    render(<TicketChecklistTemplatesPage />);
    await screen.findByTestId('checklist-template-tpl-partner');
    expect(screen.queryByTestId('checklist-template-edit-tpl-partner')).toBeNull();
    expect(screen.queryByTestId('checklist-template-delete-tpl-partner')).toBeNull();
    // Positive control: the ORG-owned template stays editable for the same user.
    expect(screen.getByTestId('checklist-template-edit-tpl-org')).toBeTruthy();
  });

  it('surfaces a 403 PARTNER_WIDE_WRITE_DENIED instead of failing silently', async () => {
    render(<TicketChecklistTemplatesPage />);
    fireEvent.click(await screen.findByTestId('checklist-template-add'));
    fireEvent.change(await screen.findByTestId('checklist-template-name'), {
      target: { value: 'Blocked' },
    });
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ error: 'Nope', code: 'PARTNER_WIDE_WRITE_DENIED' }, 403),
    );
    fireEvent.click(screen.getByTestId('checklist-template-submit'));

    expect(await screen.findByTestId('checklist-template-form-error')).toBeTruthy();
    await waitFor(() => expect(showToast).toHaveBeenCalled());
  });

  it('shows a load failure instead of an empty list', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'boom' }, 500));
    render(<TicketChecklistTemplatesPage />);
    expect(await screen.findByTestId('checklist-templates-error')).toBeTruthy();
  });
});
