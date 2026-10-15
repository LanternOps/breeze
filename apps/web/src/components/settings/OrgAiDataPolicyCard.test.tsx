import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key) }) }));
const runAction = vi.hoisted(() => vi.fn());
vi.mock('@/lib/runAction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/runAction')>('@/lib/runAction');
  return { ...actual, runAction };
});
const fetchWithAuth = vi.hoisted(() => vi.fn());
const handleSessionExpired = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth', () => ({ fetchWithAuth, handleSessionExpired }));

import OrgAiDataPolicyCard from './OrgAiDataPolicyCard';

const resolved = {
  deviceFileReadLevel: 'no_user_profiles',
  toolOutputRetentionDays: 30,
  source: { deviceFileReadLevel: 'partner', toolOutputRetentionDays: 'default' },
};
const getResponse = () => ({ ok: true, json: async () => ({ policy: null, effective: resolved, ceiling: resolved }) });

beforeEach(() => {
  vi.clearAllMocks();
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
});
