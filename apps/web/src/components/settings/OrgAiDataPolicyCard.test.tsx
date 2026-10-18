import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key) }) }));
const runAction = vi.hoisted(() => vi.fn());
vi.mock('@/lib/runAction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/runAction')>('@/lib/runAction');
  return { ...actual, runAction };
});
const showToast = vi.hoisted(() => vi.fn());
vi.mock('../shared/Toast', () => ({ showToast }));
const fetchWithAuth = vi.hoisted(() => vi.fn());
const handleSessionExpired = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth', () => ({ fetchWithAuth, handleSessionExpired }));

import OrgAiDataPolicyCard from './OrgAiDataPolicyCard';
import { ActionError } from '@/lib/runAction';

const resolved = {
  deviceFileReadLevel: 'no_user_profiles',
  toolOutputRetentionDays: 30,
  source: { deviceFileReadLevel: 'partner', toolOutputRetentionDays: 'default' },
};
// effective differs from ceiling: the org stored a tighter level than the partner ceiling.
const effectiveOff = {
  deviceFileReadLevel: 'off',
  toolOutputRetentionDays: 30,
  source: { deviceFileReadLevel: 'org', toolOutputRetentionDays: 'default' },
};
let currentPolicy: Record<string, unknown> | null = null;
let currentEffective: Record<string, unknown> = resolved;
const getResponse = () => ({ ok: true, json: async () => ({ policy: currentPolicy, effective: currentEffective, ceiling: resolved }) });

beforeEach(() => {
  vi.clearAllMocks();
  currentPolicy = null;
  currentEffective = resolved;
  fetchWithAuth.mockImplementation(async () => getResponse());
  runAction.mockImplementation(async (opts: { request: () => Promise<unknown> }) => { await opts.request(); return {}; });
});

describe('OrgAiDataPolicyCard', () => {
  it('shows the inherited level with its source and disables options above the ceiling', async () => {
    render(<OrgAiDataPolicyCard orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('org-ai-data-policy-card')).toBeInTheDocument());
    expect(fetchWithAuth).toHaveBeenCalledWith('/ai/data-policy?orgId=org-1');
    expect(screen.getByTestId('org-ai-data-policy-level-inherit')).toHaveTextContent(/partner/i);
    expect(screen.getByTestId('org-ai-data-policy-level-any_with_approval')).toBeDisabled();
    expect(screen.getByTestId('org-ai-data-policy-level-off')).not.toBeDisabled();
  });

  it('labels Inherit with the partner ceiling, not the org-stored effective value', async () => {
    currentPolicy = { deviceFileReadLevel: 'off', toolOutputRetentionDays: null };
    currentEffective = effectiveOff;
    render(<OrgAiDataPolicyCard orgId="org-1" />);
    const inherit = await screen.findByTestId('org-ai-data-policy-level-inherit');
    expect(inherit).toHaveTextContent('aiDataPolicy.levels.no_user_profiles.label');
    expect(inherit).toHaveTextContent('aiDataPolicy.sourcePartner');
    expect(inherit).not.toHaveTextContent('aiDataPolicy.sourceOrg');
  });

  it('reverts the retention field to the stored value after a rejected save', async () => {
    currentPolicy = { deviceFileReadLevel: null, toolOutputRetentionDays: 10 };
    runAction.mockRejectedValueOnce(new ActionError('above ceiling', 422));
    render(<OrgAiDataPolicyCard orgId="org-1" />);
    const input = (await screen.findByTestId('org-ai-data-policy-retention')) as HTMLInputElement;
    expect(input.value).toBe('10');
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.blur(input);
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByTestId('org-ai-data-policy-retention') as HTMLInputElement).value).toBe('10'));
  });

  it('PUTs the chosen level when a radio is clicked', async () => {
    render(<OrgAiDataPolicyCard orgId="org-1" />);
    const off = await screen.findByTestId('org-ai-data-policy-level-off');
    fireEvent.click(off);
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
    expect(fetchWithAuth).toHaveBeenCalledWith('/ai/data-policy?orgId=org-1', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ deviceFileReadLevel: 'off' }),
    }));
  });

  it('refuses a retention above the ceiling client-side: no PUT, toast, input reverts', async () => {
    currentPolicy = { deviceFileReadLevel: null, toolOutputRetentionDays: 10 };
    render(<OrgAiDataPolicyCard orgId="org-1" />);
    const input = (await screen.findByTestId('org-ai-data-policy-retention')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '60' } });
    fireEvent.blur(input);
    await waitFor(() => expect((screen.getByTestId('org-ai-data-policy-retention') as HTMLInputElement).value).toBe('10'));
    expect(runAction).not.toHaveBeenCalled();
    expect(fetchWithAuth.mock.calls.some(([, init]) => (init as { method?: string } | undefined)?.method === 'PUT')).toBe(false);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringContaining('aiDataPolicy.retentionAboveCeiling') }));
  });

  it.each([
    ['toolOutputRetentionDays', 'aiDataPolicy.retentionAboveCeiling'],
    ['deviceFileReadLevel', 'aiDataPolicy.aboveCeilingLevel'],
  ])('translates a server 422 above_partner_ceiling (%s) instead of toasting the raw token', async (field, key) => {
    const actual = await vi.importActual<typeof import('@/lib/runAction')>('@/lib/runAction');
    runAction.mockImplementation(actual.runAction);
    currentPolicy = { deviceFileReadLevel: null, toolOutputRetentionDays: 10 };
    fetchWithAuth.mockImplementation(async (_url: string, init?: { method?: string }) =>
      init?.method === 'PUT'
        ? { ok: false, status: 422, json: async () => ({ error: 'above_partner_ceiling', field }) }
        : getResponse());
    render(<OrgAiDataPolicyCard orgId="org-1" />);
    if (field === 'deviceFileReadLevel') {
      fireEvent.click(await screen.findByTestId('org-ai-data-policy-level-off'));
    } else {
      const input = await screen.findByTestId('org-ai-data-policy-retention');
      fireEvent.change(input, { target: { value: '20' } });
      fireEvent.blur(input);
    }
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    const messages = showToast.mock.calls.map(([a]) => (a as { message: string }).message);
    expect(messages.some((m) => m.startsWith(key))).toBe(true);
    expect(messages.join(' ')).not.toContain('above_partner_ceiling');
  });
});
