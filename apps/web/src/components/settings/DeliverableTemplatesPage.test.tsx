import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

// Mutable state the mocked hooks/store read from, mirroring
// CustomFieldsPage.ownerScope.test.tsx (#2135 step 6) so each test can vary
// the partner-scope / capability combination this page sees.
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
import DeliverableTemplatesPage from './DeliverableTemplatesPage';
import type { TemplateSet } from '../../lib/api/deliverableTemplates';

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

function setFrom(overrides: Partial<TemplateSet> = {}): TemplateSet {
  return {
    id: 'set-1',
    orgId: 'org-1',
    partnerId: null,
    ownerScope: 'organization',
    name: 'Best plan',
    description: null,
    items: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const PARTNER_WIDE_SET = setFrom({
  id: 'set-partner',
  orgId: null,
  partnerId: 'partner-1',
  ownerScope: 'partner',
  name: 'Gold tier',
});

beforeEach(() => {
  vi.clearAllMocks();
  state.canManagePartnerWide = undefined;
  state.isPartnerScope = true;
  state.defaultOwnerScope = 'organization';
  state.currentOrgId = 'org-1';
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    const method = opts?.method ?? 'GET';
    if (String(url).startsWith('/deliverable-templates') && method === 'GET') {
      return jsonResponse({ data: [PARTNER_WIDE_SET, setFrom()] });
    }
    return jsonResponse({ error: 'unexpected' }, 500);
  });
});

describe('DeliverableTemplatesPage', () => {
  it('renders the All orgs badge for a partner-wide set and not for an org-owned one', async () => {
    render(<DeliverableTemplatesPage />);
    const badges = await screen.findAllByTestId('deliverable-template-all-orgs-badge');
    expect(badges).toHaveLength(1);
    const partnerSetCard = screen.getByTestId('deliverable-template-set-set-partner');
    expect(partnerSetCard.textContent).toContain('Gold tier');
    const orgSetCard = screen.getByTestId('deliverable-template-set-set-1');
    expect(orgSetCard.querySelector('[data-testid="deliverable-template-all-orgs-badge"]')).toBeNull();
  });

  it('shows the ownerScope selector only on create, and only for a partner admin', async () => {
    state.canManagePartnerWide = true;
    render(<DeliverableTemplatesPage />);
    await screen.findByTestId('deliverable-template-set-set-1');
    expect(screen.queryByTestId('deliverable-template-owner')).toBeNull();

    fireEvent.click(screen.getByTestId('deliverable-template-add'));
    expect(screen.getByTestId('deliverable-template-owner')).toBeInTheDocument();
    expect(screen.getByTestId('deliverable-template-owner-partner')).toBeInTheDocument();
    expect(screen.getByTestId('deliverable-template-owner-org')).toBeInTheDocument();

    // Not shown when editing an existing set.
    fireEvent.click(screen.getByTestId('deliverable-template-add'), { bubbles: true });
    fireEvent.click(screen.getAllByTestId('deliverable-template-edit')[0]!);
    expect(screen.queryByTestId('deliverable-template-owner')).toBeNull();
  });

  it('hides the selector for a partner tech whose canManagePartnerWide is false', async () => {
    state.canManagePartnerWide = false;
    render(<DeliverableTemplatesPage />);
    await screen.findByTestId('deliverable-template-set-set-1');
    fireEvent.click(screen.getByTestId('deliverable-template-add'));
    expect(screen.queryByTestId('deliverable-template-owner')).toBeNull();
  });

  it('POSTs ownerScope partner when All organizations is selected', async () => {
    state.canManagePartnerWide = true;
    render(<DeliverableTemplatesPage />);
    await screen.findByTestId('deliverable-template-set-set-1');

    fireEvent.click(screen.getByTestId('deliverable-template-add'));
    fireEvent.change(screen.getByTestId('deliverable-template-name'), { target: { value: 'Platinum tier' } });
    fireEvent.click(screen.getByTestId('deliverable-template-owner-partner'));
    fireEvent.click(screen.getByTestId('deliverable-template-submit'));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, opts]) => url === '/deliverable-templates' && (opts as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(String((call![1] as RequestInit).body));
      expect(body.ownerScope).toBe('partner');
      expect(body.orgId).toBeUndefined();
      expect(body.name).toBe('Platinum tier');
    });
  });

  it('POSTs ownerScope organization by default with a concrete org selected', async () => {
    state.canManagePartnerWide = true;
    state.currentOrgId = 'org-9';
    render(<DeliverableTemplatesPage />);
    await screen.findByTestId('deliverable-template-set-set-1');

    fireEvent.click(screen.getByTestId('deliverable-template-add'));
    fireEvent.change(screen.getByTestId('deliverable-template-name'), { target: { value: 'Silver tier' } });
    fireEvent.click(screen.getByTestId('deliverable-template-submit'));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, opts]) => url === '/deliverable-templates' && (opts as RequestInit | undefined)?.method === 'POST',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(String((call![1] as RequestInit).body));
      expect(body.ownerScope).toBe('organization');
      expect(body.orgId).toBe('org-9');
    });
  });

  it('hides edit and delete on a partner-wide set when canManagePartnerWide is false', async () => {
    state.canManagePartnerWide = false;
    render(<DeliverableTemplatesPage />);
    await screen.findByTestId('deliverable-template-set-set-partner');
    const partnerCard = screen.getByTestId('deliverable-template-set-set-partner');
    expect(partnerCard.querySelector('[data-testid="deliverable-template-edit"]')).toBeNull();
    expect(partnerCard.querySelector('[data-testid="deliverable-template-delete"]')).toBeNull();
    // Org-owned set is still mutable by the same actor.
    const orgCard = screen.getByTestId('deliverable-template-set-set-1');
    expect(orgCard.querySelector('[data-testid="deliverable-template-edit"]')).not.toBeNull();
  });

  it('surfaces the 409 DUPLICATE_TEMPLATE_SET_NAME message from the response, not a generic error', async () => {
    render(<DeliverableTemplatesPage />);
    await screen.findByTestId('deliverable-template-set-set-1');

    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ error: 'a set named this already exists', code: 'DUPLICATE_TEMPLATE_SET_NAME' }, 409),
    );

    fireEvent.click(screen.getByTestId('deliverable-template-add'));
    fireEvent.change(screen.getByTestId('deliverable-template-name'), { target: { value: 'Best plan' } });
    fireEvent.click(screen.getByTestId('deliverable-template-submit'));

    const error = await screen.findByTestId('deliverable-template-form-error');
    expect(error.textContent).toBe('A template set with this name already exists.');
  });

  it('adds and removes an item through runAction and shows the toast', async () => {
    render(<DeliverableTemplatesPage />);
    const orgCard = await screen.findByTestId('deliverable-template-set-set-1');

    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({
        data: {
          id: 'item-1',
          setId: 'set-1',
          name: 'Monthly report',
          description: null,
          cadence: 'monthly',
          leadDays: 7,
          graceDays: 14,
          artifactRequired: true,
          completionMode: 'on_ticket_resolve',
          sortOrder: 0,
        },
      }),
    );

    fireEvent.click(orgCard.querySelector('[data-testid="deliverable-template-item-add"]')!);
    fireEvent.change(screen.getByTestId('deliverable-template-item-name'), { target: { value: 'Monthly report' } });
    fireEvent.click(screen.getByTestId('deliverable-template-item-submit'));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Deliverable saved' }));
    });
    await screen.findByTestId('deliverable-template-item-item-1');

    fetchMock.mockImplementationOnce(async () => jsonResponse({ data: null }));
    fireEvent.click(screen.getByTestId('deliverable-template-item-remove-item-1'));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Deliverable removed' }));
    });
    expect(screen.queryByTestId('deliverable-template-item-item-1')).toBeNull();
  });
});
