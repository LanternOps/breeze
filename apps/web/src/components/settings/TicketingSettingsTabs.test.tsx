import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { grantedActions, currentScope } = vi.hoisted(() => ({
  grantedActions: new Set<string>(),
  currentScope: { value: 'partner' as 'partner' | 'organization' },
}));
// Every case in this file describes an already-WARM page: the scope is known
// before the group renders. The cold-load window (`status: 'unresolved'`,
// which is where every direct landing on this surface actually starts) is what
// TicketingSettingsTabs.coldLoad.test.tsx covers, driving the real auth store.
// `currentScope` is mutable so the org-scope describe block below can flip it
// without a separate mock module.
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: () => ({ scope: currentScope.value, orgId: currentScope.value === 'organization' ? 'org-1' : null, partnerId: currentScope.value === 'partner' ? 'partner-1' : null }),
  useJwtClaims: () => ({
    status: 'resolved' as const,
    claims: { scope: currentScope.value, orgId: currentScope.value === 'organization' ? 'org-1' : null, partnerId: currentScope.value === 'partner' ? 'partner-1' : null },
  }),
}));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({
    can: (resource: string, action: string) => grantedActions.has(`${resource}:${action}`),
  }),
}));

// Stub child components — we test only the tab group's switching behaviour.
vi.mock('./TicketCategoriesPage', () => ({
  default: () => <div data-testid="stub-ticket-categories-page">CategoriesStub</div>
}));
vi.mock('./TicketStatusesTab', () => ({
  default: () => <div data-testid="stub-ticket-statuses-tab">StatusesStub</div>
}));
vi.mock('./TicketPrioritiesTab', () => ({
  default: () => <div data-testid="stub-ticket-priorities-tab">PrioritiesStub</div>
}));
vi.mock('./InboundEmailCard', () => ({
  default: () => <div data-testid="stub-inbound-email-card">InboundStub</div>
}));
vi.mock('./M365MailboxCard', () => ({
  default: () => <div data-testid="m365-mailbox-card">MailboxStub</div>
}));
vi.mock('./CannedResponsesCard', () => ({
  default: () => <div data-testid="stub-canned-responses-card">CannedStub</div>
}));
vi.mock('./TicketChecklistTemplatesPage', () => ({
  default: () => <div data-testid="stub-ticket-checklist-templates-page">ChecklistTemplatesStub</div>
}));
vi.mock('./TicketFormsCard', () => ({
  default: () => <div data-testid="stub-ticket-forms-card">FormsStub</div>
}));
vi.mock('./TimeTrackingSettingsCard', () => ({
  default: () => <div data-testid="stub-time-tracking-card">TimeTrackingStub</div>
}));

import TicketingSettingsTabs from './TicketingSettingsTabs';
import { applyLocale, i18n } from '@/lib/i18n';

function renderWithPartnerScope() {
  return render(<TicketingSettingsTabs />);
}

describe('TicketingSettingsTabs', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    window.location.hash = '';
    grantedActions.clear();
    currentScope.value = 'partner';
  });

  afterEach(async () => {
    window.location.hash = '';
    await i18n.changeLanguage('en');
    currentScope.value = 'partner';
  });

  it('renders all seven tabs and defaults to statuses', () => {
    renderWithPartnerScope();
    expect(screen.getByTestId('ticketing-tab-statuses')).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-priorities')).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-categories')).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-forms')).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-email')).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-templates')).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-timeTracking')).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-panel-statuses')).toBeInTheDocument();
  });

  it('switches tabs and syncs the URL hash', () => {
    renderWithPartnerScope();
    fireEvent.click(screen.getByTestId('ticketing-tab-categories'));
    expect(screen.getByTestId('stub-ticket-categories-page')).toBeInTheDocument();
    expect(window.location.hash).toBe('#categories');
  });

  it('honors a hash deep link on mount', () => {
    window.location.hash = '#timeTracking';
    renderWithPartnerScope();
    expect(screen.getByTestId('stub-time-tracking-card')).toBeInTheDocument();
  });

  it('renders the merged Email tab (inbound + M365, no separate customer-domains tab)', async () => {
    renderWithPartnerScope();
    await userEvent.click(screen.getByTestId('ticketing-tab-email'));
    expect(screen.getByTestId('ticketing-tab-panel-email')).toBeInTheDocument();
    expect(screen.queryByTestId('ticketing-tab-panel-inbound')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ticketing-tab-canned')).not.toBeInTheDocument();
  });

  it('renders the merged Templates tab (canned responses + checklist templates)', async () => {
    renderWithPartnerScope();
    await userEvent.click(screen.getByTestId('ticketing-tab-templates'));
    expect(screen.getByTestId('ticketing-tab-panel-templates')).toBeInTheDocument();
    expect(screen.getByTestId('stub-canned-responses-card')).toBeInTheDocument();
    expect(screen.getByTestId('stub-ticket-checklist-templates-page')).toBeInTheDocument();
  });

  it('has no Export tab (moved out under M5)', () => {
    renderWithPartnerScope();
    expect(screen.queryByTestId('ticketing-tab-export')).not.toBeInTheDocument();
  });

  it('renders Time capture (renamed from Time Tracking)', async () => {
    renderWithPartnerScope();
    await userEvent.click(screen.getByTestId('ticketing-tab-timeTracking'));
    expect(screen.getByTestId('ticketing-tab-panel-timeTracking')).toBeInTheDocument();
    expect(screen.getByText('Time capture')).toBeInTheDocument();
  });

  it('hides the mailbox settings surface without ticket_mailbox read permission', async () => {
    renderWithPartnerScope();
    await userEvent.click(screen.getByTestId('ticketing-tab-email'));
    expect(screen.getByTestId('stub-inbound-email-card')).toBeInTheDocument();
    expect(screen.queryByTestId('m365-mailbox-card')).not.toBeInTheDocument();
  });

  it('shows the mailbox settings surface with ticket_mailbox read permission', async () => {
    grantedActions.add('ticket_mailbox:read');
    renderWithPartnerScope();
    await userEvent.click(screen.getByTestId('ticketing-tab-email'));
    expect(screen.getByTestId('m365-mailbox-card')).toBeInTheDocument();
  });

  it('updates already-mounted tab labels when the locale changes', async () => {
    renderWithPartnerScope();
    expect(screen.getByTestId('ticketing-tab-categories')).toHaveTextContent('Categories');

    await act(async () => {
      await applyLocale('pt-BR');
    });

    expect(screen.getByTestId('ticketing-tab-categories')).toHaveTextContent('Categorias');
  });
});

describe('TicketingSettingsTabs — org scope (dual-ownership Templates tab regression)', () => {
  beforeEach(() => {
    window.location.hash = '';
    grantedActions.clear();
    currentScope.value = 'organization';
  });

  afterEach(() => {
    window.location.hash = '';
    currentScope.value = 'partner';
  });

  it('shows the Templates tab for an org-scoped user, rendering only the checklist templates page', async () => {
    render(<TicketingSettingsTabs />);
    expect(screen.getByTestId('ticketing-tab-templates')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('ticketing-tab-templates'));
    expect(screen.getByTestId('ticketing-tab-panel-templates')).toBeInTheDocument();
    expect(screen.getByTestId('stub-ticket-checklist-templates-page')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-canned-responses-card')).not.toBeInTheDocument();
    // No pending placeholder in place of the checklist page — templates is not
    // gated on scope resolution any more.
    expect(screen.queryByTestId('ticketing-tab-panel-pending')).not.toBeInTheDocument();
  });

  it('shows both CannedResponsesCard and TicketChecklistTemplatesPage for a partner-scoped user (control)', async () => {
    currentScope.value = 'partner';
    render(<TicketingSettingsTabs />);
    await userEvent.click(screen.getByTestId('ticketing-tab-templates'));
    expect(screen.getByTestId('stub-canned-responses-card')).toBeInTheDocument();
    expect(screen.getByTestId('stub-ticket-checklist-templates-page')).toBeInTheDocument();
  });

  it('does not widen access: forms/email/timeTracking tabs stay hidden for org scope', () => {
    render(<TicketingSettingsTabs />);
    expect(screen.queryByTestId('ticketing-tab-forms')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ticketing-tab-email')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ticketing-tab-timeTracking')).not.toBeInTheDocument();
  });
});
