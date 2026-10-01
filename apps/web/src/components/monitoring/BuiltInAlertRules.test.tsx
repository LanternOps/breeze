import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (sel: (s: { organizations: { id: string; name: string }[] }) => unknown) =>
    sel({ organizations: [{ id: 'org-1', name: 'Acme Dental' }] }),
}));

import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import BuiltInAlertRules from './BuiltInAlertRules';

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(body), headers: new Headers() }) as unknown as Response;

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-patch', name: 'Patch job failures', orgId: 'org-1', partnerId: null,
    isActive: true, systemManaged: true, managedByMonitorId: null, ...overrides,
  };
}

describe('BuiltInAlertRules (#7626)', () => {
  beforeEach(() => {
    vi.mocked(fetchWithAuth).mockReset();
    vi.mocked(showToast).mockReset();
  });

  it('lists only built-in rules, scoped to the current org when one is selected', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(json({ data: [rule()] }));
    render(<BuiltInAlertRules orgId="org-1" />);
    await screen.findByTestId('builtin-alert-rules-row-rule-patch');
    expect(fetchWithAuth).toHaveBeenCalledWith('/alerts/rules?limit=200&systemManaged=true&orgId=org-1');
    expect(screen.getByTestId('builtin-alert-rules-row-rule-patch').textContent).toContain('Acme Dental');
  });

  it('defends against a non-built-in row slipping into the response', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(json({ data: [
      rule(),
      rule({ id: 'rule-custom', name: 'High CPU', systemManaged: false }),
    ] }));
    render(<BuiltInAlertRules />);
    await screen.findByTestId('builtin-alert-rules-row-rule-patch');
    expect(fetchWithAuth).toHaveBeenCalledWith('/alerts/rules?limit=200&systemManaged=true');
    expect(screen.queryByTestId('builtin-alert-rules-row-rule-custom')).toBeNull();
  });

  it('switches a rule off through PATCH /active and shows the new state', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce(json({ data: [rule()] }))
      .mockResolvedValueOnce(json({ ...rule(), isActive: false }));
    render(<BuiltInAlertRules />);
    const toggle = await screen.findByTestId('builtin-alert-rules-active-rule-patch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(toggle);

    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(fetchWithAuth).toHaveBeenLastCalledWith('/alerts/rules/rule-patch/active', {
      method: 'PATCH',
      body: JSON.stringify({ isActive: false }),
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('keeps the old state and surfaces the failure when the API refuses', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce(json({ data: [rule()] }))
      .mockResolvedValueOnce(json({ error: 'MFA required' }, 403));
    render(<BuiltInAlertRules />);
    const toggle = await screen.findByTestId('builtin-alert-rules-active-rule-patch');

    fireEvent.click(toggle);

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('renders nothing when there are no built-in rules yet', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(json({ data: [] }));
    const { container } = render(<BuiltInAlertRules />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="builtin-alert-rules"]')).toBeNull();
  });
});
