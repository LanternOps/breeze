import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { grantedActions } = vi.hoisted(() => ({ grantedActions: new Set<string>() }));
// Every case in this file describes an already-WARM page: the partner scope is
// known before the group renders. The cold-load window (`status: 'unresolved'`,
// which is where every direct landing on this surface actually starts) is what
// TicketingSettingsTabs.coldLoad.test.tsx covers, driving the real auth store.
vi.mock('../../lib/authScope', () => {
  const claims = { scope: 'partner' as const, orgId: null, partnerId: 'partner-1' };
  return {
    getJwtClaims: () => claims,
    useJwtClaims: () => ({ status: 'resolved' as const, claims }),
  };
});
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({
    can: (resource: string, action: string) => grantedActions.has(`${resource}:${action}`),
  }),
}));

// Stub child components — we test only the sub-tab group's switching behaviour.
vi.mock('./TicketCategoriesPage', () => ({
  default: () => <div data-testid="stub-ticket-categories-page">CategoriesStub</div>
}));
vi.mock('./BillablesExportCard', () => ({
  default: () => <div data-testid="stub-billables-export-card">ExportStub</div>
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
vi.mock('./TicketFormsCard', () => ({
  default: () => <div data-testid="stub-ticket-forms-card">FormsStub</div>
}));
vi.mock('./TimeTrackingSettingsCard', () => ({
  default: () => <div data-testid="stub-time-tracking-card">TimeTrackingStub</div>
}));

import TicketingSettingsTabs from './TicketingSettingsTabs';
import { applyLocale, i18n } from '@/lib/i18n';

describe('TicketingSettingsTabs', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    window.location.hash = '';
    grantedActions.clear();
  });

  afterEach(async () => {
    window.location.hash = '';
    await i18n.changeLanguage('en');
  });

  it('renders all four sub-tabs and defaults to statuses', () => {
    render(<TicketingSettingsTabs />);
    expect(screen.getByTestId('ticketing-tab-statuses')).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-priorities')).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-categories')).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-export')).toBeInTheDocument();
    expect(screen.getByTestId('ticketing-tab-panel-statuses')).toBeInTheDocument();
  });

  it('switches tabs and (by default) syncs the URL hash', () => {
    render(<TicketingSettingsTabs />);
    fireEvent.click(screen.getByTestId('ticketing-tab-categories'));
    expect(screen.getByTestId('stub-ticket-categories-page')).toBeInTheDocument();
    expect(window.location.hash).toBe('#tab=categories');
  });

  it('honors a #tab= deep link on mount', () => {
    window.location.hash = '#tab=export';
    render(<TicketingSettingsTabs />);
    expect(screen.getByTestId('stub-billables-export-card')).toBeInTheDocument();
  });

  it('does NOT touch the URL hash when syncHash is false (embedded mode)', () => {
    window.location.hash = '#ticketing';
    render(<TicketingSettingsTabs syncHash={false} />);
    fireEvent.click(screen.getByTestId('ticketing-tab-export'));
    // Tab still switches locally...
    expect(screen.getByTestId('stub-billables-export-card')).toBeInTheDocument();
    // ...but the owning hub's top-level hash is left untouched.
    expect(window.location.hash).toBe('#ticketing');
  });

  it('seeds the initial sub-tab from the initialTab prop (deterministic deep-link)', () => {
    // The M365 consent deep-link relies on the parent passing initialTab so the group
    // opens on the right sub-tab regardless of remounts — independent of any URL param
    // the mailbox card may have already stripped.
    render(<TicketingSettingsTabs syncHash={false} initialTab="export" />);
    expect(screen.getByTestId('stub-billables-export-card')).toBeInTheDocument();
    expect(screen.queryByTestId('ticketing-tab-panel-statuses')).toBeNull();
  });

  it('ignores #tab= deep links when syncHash is false', () => {
    window.location.hash = '#tab=export';
    render(<TicketingSettingsTabs syncHash={false} />);
    // Embedded mode starts on the default statuses tab regardless of #tab=.
    expect(screen.getByTestId('ticketing-tab-panel-statuses')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-billables-export-card')).toBeNull();
  });

  it('hides the mailbox settings surface without ticket_mailbox read permission', () => {
    render(<TicketingSettingsTabs syncHash={false} initialTab="inbound" />);

    expect(screen.getByTestId('stub-inbound-email-card')).toBeInTheDocument();
    expect(screen.queryByTestId('m365-mailbox-card')).not.toBeInTheDocument();
  });

  it('shows the mailbox settings surface with ticket_mailbox read permission', () => {
    grantedActions.add('ticket_mailbox:read');

    render(<TicketingSettingsTabs syncHash={false} initialTab="inbound" />);

    expect(screen.getByTestId('m365-mailbox-card')).toBeInTheDocument();
  });

  it('updates already-mounted tab labels when the locale changes', async () => {
    render(<TicketingSettingsTabs />);
    expect(screen.getByTestId('ticketing-tab-categories')).toHaveTextContent('Categories');

    await act(async () => {
      await applyLocale('pt-BR');
    });

    expect(screen.getByTestId('ticketing-tab-categories')).toHaveTextContent('Categorias');
  });
});

// W06 (#3900): the Time Tracking tab is partner-only for the same reason the
// other three are — the setting it edits is partner-wide, and PATCH
// /orgs/partners/me requires partner scope server-side.
describe('TicketingSettingsTabs — Time Tracking tab (W06 #3900)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    window.location.hash = '';
    grantedActions.clear();
  });

  it('shows the Time Tracking tab for a partner user and mounts its card', () => {
    render(<TicketingSettingsTabs />);
    const tab = screen.getByTestId('ticketing-tab-timeTracking');
    expect(tab).toBeTruthy();
    fireEvent.click(tab);
    expect(screen.getByTestId('stub-time-tracking-card')).toBeTruthy();
  });
});
