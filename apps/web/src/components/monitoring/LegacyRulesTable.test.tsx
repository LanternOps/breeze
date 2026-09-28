import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import { fetchWithAuth } from '../../stores/auth';
import LegacyRulesTable from './LegacyRulesTable';

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(body), headers: new Headers() }) as unknown as Response;

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1', name: 'High CPU', templateId: 't-1', templateName: 'CPU template',
    targetType: 'org', targetId: 'org-1', orgId: 'org-1', partnerId: null, isActive: true,
    managedByMonitorId: null, convertedToMonitorId: null, systemManaged: false,
    ...overrides,
  };
}

describe('LegacyRulesTable (#7206)', () => {
  beforeEach(() => vi.mocked(fetchWithAuth).mockReset());

  it('asks the API for the needs-conversion set', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(json({ data: [rule()] }));
    render(<LegacyRulesTable />);
    await screen.findByTestId('legacy-rules-row-rule-1');
    expect(fetchWithAuth).toHaveBeenCalledWith('/alerts/rules?limit=200&needsConversion=true');
  });

  it('never offers Convert on a built-in system anchor rule or a monitor-managed rule', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(json({ data: [
      rule(),
      rule({ id: 'rule-anchor', name: 'Reboot pending too long', templateName: 'Reboot pending too long', systemManaged: true }),
      rule({ id: 'rule-managed', managedByMonitorId: 'monitor-1' }),
    ] }));
    render(<LegacyRulesTable />);
    await screen.findByTestId('legacy-rules-row-rule-1');
    expect(screen.queryByTestId('legacy-rules-row-rule-anchor')).toBeNull();
    expect(screen.queryByTestId('legacy-rules-convert-rule-anchor')).toBeNull();
    expect(screen.queryByTestId('legacy-rules-row-rule-managed')).toBeNull();
  });

  it('shows the system-managed explanation, not "not found", when the API refuses a built-in rule', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce(json({ data: [rule()] }))
      .mockResolvedValueOnce(json({
        error: 'System-managed rule — it keeps alerting on its own and needs no conversion',
        code: 'RULE_SYSTEM_MANAGED',
      }, 409));
    render(<LegacyRulesTable />);
    fireEvent.click(await screen.findByTestId('legacy-rules-convert-rule-1'));
    await waitFor(() => expect(screen.getByTestId('legacy-rules-row-rule-1').textContent)
      .toContain('System-managed rule. Breeze raises this alert itself, so there is nothing to convert.'));
  });
});
