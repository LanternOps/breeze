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

import PartnerAiDataPolicyCard from './PartnerAiDataPolicyCard';

const defaults = { deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: 30 };
function respond(canManage: boolean, policy: Record<string, unknown> | null) {
  fetchWithAuth.mockImplementation(async () => ({ ok: true, json: async () => ({ policy, canManage, defaults }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  runAction.mockImplementation(async (opts: { request: () => Promise<unknown> }) => { await opts.request(); return {}; });
});

describe('PartnerAiDataPolicyCard', () => {
  it('renders the stored values from GET and names the Breeze default on the inherit option', async () => {
    respond(true, { deviceFileReadLevel: 'off', toolOutputRetentionDays: 14 });
    render(<PartnerAiDataPolicyCard />);
    await waitFor(() => expect(screen.getByTestId('partner-ai-data-policy-card')).toBeInTheDocument());
    expect(fetchWithAuth).toHaveBeenCalledWith('/partner/ai/data-policy');
    expect((screen.getByTestId('partner-ai-data-policy-level-off') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('partner-ai-data-policy-retention') as HTMLInputElement).value).toBe('14');
    const inherit = screen.getByTestId('partner-ai-data-policy-level-inherit');
    expect(inherit).toHaveTextContent('aiDataPolicy.partnerInheritDefault');
    expect(inherit).toHaveTextContent('aiDataPolicy.levels.no_user_profiles.label');
  });

  it('PUTs the chosen level when a manager clicks a radio', async () => {
    respond(true, null);
    render(<PartnerAiDataPolicyCard />);
    fireEvent.click(await screen.findByTestId('partner-ai-data-policy-level-any_with_approval'));
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
    expect(fetchWithAuth).toHaveBeenCalledWith('/partner/ai/data-policy', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ deviceFileReadLevel: 'any_with_approval' }),
    }));
  });

  it('is read-only and never PUTs when canManage is false', async () => {
    respond(false, { deviceFileReadLevel: 'off', toolOutputRetentionDays: null });
    render(<PartnerAiDataPolicyCard />);
    const off = (await screen.findByTestId('partner-ai-data-policy-level-off')) as HTMLInputElement;
    expect(off.disabled).toBe(true);
    expect((screen.getByTestId('partner-ai-data-policy-retention') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('partner-ai-data-policy-level-any_with_approval'));
    fireEvent.blur(screen.getByTestId('partner-ai-data-policy-retention'));
    expect(runAction).not.toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });
});
