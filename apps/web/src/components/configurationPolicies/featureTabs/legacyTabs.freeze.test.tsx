// legacyTabs.freeze.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../../../lib/i18n';

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (url.startsWith('/monitor-definitions')
      ? { data: [
          { id: 'm-cpu', name: 'High CPU usage', kind: 'cpu', condition: { operator: 'gt', value: 90 }, severity: 'high', enabled: true, builtinKey: 'cpu_high' },
          { id: 'm-svc', name: 'Spooler stopped', kind: 'service', condition: { serviceName: 'Spooler' }, severity: 'high', enabled: true, builtinKey: null },
        ] }
      : { data: [] }),
  })),
}));

import AlertRuleTab from './AlertRuleTab';
import MonitoringTab from './MonitoringTab';
import MonitorsTab from './MonitorsTab';

const alertRuleLink = {
  id: 'l-ar', featureType: 'alert_rule', featurePolicyId: null,
  inlineSettings: { items: [{ name: 'Alert Rule 1', severity: 'medium', conditions: [{ type: 'metric', metric: 'cpuPercent', operator: 'gt', value: 80 }], cooldownMinutes: 15, autoResolve: false }] },
} as any;
const monitorsLink = { id: 'l-mon', featureType: 'monitors', featurePolicyId: null, inlineSettings: { items: [{ monitorId: 'm-cpu', enabled: true }] } } as any;
const base = { policyId: 'p-1', linkedPolicyId: null, orgId: 'o-1', onLinkChanged: vi.fn() } as any;

describe('legacy tabs after W05a', () => {
  it('AlertRuleTab shows the freeze notice instead of an add button', () => {
    render(<AlertRuleTab {...base} existingLink={alertRuleLink} allLinks={[alertRuleLink, monitorsLink]} />);
    expect(screen.getByTestId('legacy-freeze-notice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add alert rule/i })).toBeNull();
  });
  it('AlertRuleTab warns about the CPU duplicate', async () => {
    render(<AlertRuleTab {...base} existingLink={alertRuleLink} allLinks={[alertRuleLink, monitorsLink]} />);
    expect(await screen.findByTestId('duplicate-condition-notice')).toHaveTextContent('Alert Rule 1 ↔ High CPU usage');
  });
  it('MonitoringTab shows the freeze notice and no add-watch control', () => {
    const monLink = { id: 'l-w', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { checkIntervalSeconds: 60, watches: [] } } as any;
    render(<MonitoringTab {...base} existingLink={monLink} allLinks={[monLink, monitorsLink]} />);
    expect(screen.getByTestId('legacy-freeze-notice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Add Watch$/i })).toBeNull();
  });
  it('MonitorsTab warns about the same duplicate from its side', async () => {
    render(<MonitorsTab {...base} existingLink={monitorsLink} allLinks={[alertRuleLink, monitorsLink]} />);
    expect(await screen.findByTestId('duplicate-condition-notice')).toHaveTextContent('High CPU usage');
  });
});

it('retains the service condition through the actual MonitorsTab catalog mapper', async () => {
  const watches = { id: 'l-watch', featureType: 'monitoring' as const, featurePolicyId: null,
    inlineSettings: { watches: [{ watchType: 'service', name: 'spooler', enabled: true }] } };
  const attached = { ...monitorsLink, inlineSettings: { items: [{ monitorId: 'm-svc', enabled: true }] } };
  render(<MonitorsTab {...base} existingLink={attached} allLinks={[attached, watches]} />);
  expect(await screen.findByTestId('duplicate-condition-notice')).toHaveTextContent('spooler ↔ Spooler stopped');
});
