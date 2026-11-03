import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@/lib/i18n';
import PartnerDefaultsTab from '../PartnerDefaultsTab';
import PartnerRemoteAccessTab from '../PartnerRemoteAccessTab';
import PartnerAiBudgetsTab from '../PartnerAiBudgetsTab';
import PartnerAiApprovalsTab from '../PartnerAiApprovalsTab';
import PartnerSecurityTab from '../PartnerSecurityTab';
import PartnerEventLogsTab from '../PartnerEventLogsTab';
import PartnerNotificationsTab from '../PartnerNotificationsTab';
import PartnerRegionalTab from '../PartnerRegionalTab';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn(), useAuthStore: () => undefined }));

/**
 * Spec §5.3: hints that restate the inheritance model are replaced by the
 * per-field badge, so the copy cannot drift from the catalog again.
 */
const RESTATEMENTS = [
  /can pick a different default for themselves/i,
  /an organization can override it/i,
  /organizations cannot override it/i,
  /override and lock the same field/i,
  /organizations can override this value/i,
];

function expectNoRestatement() {
  const text = document.body.textContent ?? '';
  for (const pattern of RESTATEMENTS) expect(text).not.toMatch(pattern);
}

describe('model-restating hints are gone (badges replace them)', () => {
  it('Defaults', () => {
    render(<PartnerDefaultsTab data={{}} onChange={vi.fn()} pinnableVersions={null} />);
    expectNoRestatement();
    // The first sentence of each enrollment hint stays.
    expect(screen.getByText(/Pre-selects how long new enrollment links/)).toBeInTheDocument();
  });

  it('Remote access', () => {
    render(<PartnerRemoteAccessTab data={{}} onChange={vi.fn()} networkProxy={{}} onNetworkProxyChange={vi.fn()} />);
    expectNoRestatement();
    expect(screen.getByText(/improves compatibility with device web UIs/)).toBeInTheDocument();
  });

  it('AI budgets', () => {
    render(<PartnerAiBudgetsTab data={{ enabled: true }} onChange={vi.fn()} />);
    expectNoRestatement();
    expect(screen.queryByTestId('partner-ai-budgets-override-note')).toBeNull();
  });

  it('AI approvals', () => {
    render(<PartnerAiApprovalsTab data={{}} onChange={vi.fn()} />);
    expectNoRestatement();
    expect(screen.queryByTestId('partner-ai-approvals-org-override-note')).toBeNull();
  });
});

describe('badges sit on the classified fields of each tab', () => {
  const badges = () => Array.from(document.querySelectorAll('[data-testid^="partner-settings-badge-"]'))
    .map(el => el.getAttribute('data-testid')!.replace('partner-settings-badge-', ''))
    .filter(id => id !== 'legend')
    .sort();

  it.each([
    ['Defaults', <PartnerDefaultsTab data={{}} onChange={vi.fn()} pinnableVersions={null} />, [
      'defaults.agentUpdatePolicy', 'defaults.agentVersionPins.agent', 'defaults.agentVersionPins.watchdog',
      'defaults.defaultEnrollmentDeviceCount', 'defaults.defaultEnrollmentTtlMinutes', 'defaults.maintenanceWindow',
      'defaults.maxEnrollmentLinkTtlMinutes',
    ]],
    ['Security', <PartnerSecurityTab data={{}} onChange={vi.fn()} status={null} />, ['security.requireMfa', 'security.sessionTimeout']],
    ['Event logs', <PartnerEventLogsTab data={{ enabled: true }} onChange={vi.fn()} />, ['eventLogs']],
    ['Notifications', <PartnerNotificationsTab data={{}} onChange={vi.fn()} />, [
      'notifications.pushoverAppToken', 'notifications.pushoverDefaultPriority',
      'notifications.pushoverDefaultSound', 'notifications.pushoverDefaultUser',
    ]],
    ['AI budgets', <PartnerAiBudgetsTab data={{ enabled: true }} onChange={vi.fn()} />, [
      'aiBudgets.alertThresholdPercents', 'aiBudgets.approvalMode', 'aiBudgets.dailyBudgetCents', 'aiBudgets.enabled',
      'aiBudgets.maxTurnsPerSession', 'aiBudgets.messagesPerHourPerOrg', 'aiBudgets.messagesPerMinutePerUser',
      'aiBudgets.monthlyBudgetCents', 'aiBudgets.toolRateLimitMultiplier',
    ]],
    ['AI approvals', <PartnerAiApprovalsTab data={{}} onChange={vi.fn()} />, ['aiApprovals.interactiveTimeoutMinutes']],
    ['Remote access', <PartnerRemoteAccessTab data={{}} onChange={vi.fn()} networkProxy={{}} onNetworkProxyChange={vi.fn()} />, [
      'networkProxy.dedicatedTunnelOrigin', 'remoteAccessProviders.providers',
    ]],
    ['Regional', <PartnerRegionalTab timezone="UTC" dateFormat="MM/DD/YYYY" timeFormat="12h" language="en"
      onTimezoneChange={vi.fn()} onDateFormatChange={vi.fn()} onTimeFormatChange={vi.fn()} onLanguageChange={vi.fn()} />, [
      'regional.dateFormat', 'regional.timeFormat',
    ]],
  ])('%s', (_name, ui, expected) => {
    render(ui);
    expect(badges()).toEqual([...expected].sort());
  });
});
