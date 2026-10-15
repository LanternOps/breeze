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
import { ActionError } from '@/lib/runAction';

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

  it('shows the Breeze default of 30 days (days mode) when no row exists', async () => {
    respond(true, null);
    render(<PartnerAiDataPolicyCard />);
    const input = (await screen.findByTestId('partner-ai-data-policy-retention')) as HTMLInputElement;
    expect(input.value).toBe('30');
    expect(input.disabled).toBe(false);
    expect((screen.getByTestId('partner-ai-data-policy-retention-days-mode') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('partner-ai-data-policy-retention-default')).toHaveTextContent('aiDataPolicy.retentionBreezeDefault');
  });

  it('selects Keep forever with an empty, disabled days field when the row has NULL retention', async () => {
    respond(true, { deviceFileReadLevel: null, toolOutputRetentionDays: null });
    render(<PartnerAiDataPolicyCard />);
    const forever = (await screen.findByTestId('partner-ai-data-policy-retention-forever')) as HTMLInputElement;
    expect(forever.checked).toBe(true);
    const input = screen.getByTestId('partner-ai-data-policy-retention') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.disabled).toBe(true);
  });

  it('Keep forever sends null; a blank days entry sends nothing and reverts', async () => {
    respond(true, { deviceFileReadLevel: null, toolOutputRetentionDays: 14 });
    render(<PartnerAiDataPolicyCard />);
    const input = (await screen.findByTestId('partner-ai-data-policy-retention')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => expect((screen.getByTestId('partner-ai-data-policy-retention') as HTMLInputElement).value).toBe('14'));
    expect(runAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('partner-ai-data-policy-retention-forever'));
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
    expect(fetchWithAuth).toHaveBeenCalledWith('/partner/ai/data-policy', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ toolOutputRetentionDays: null }),
    }));
  });

  it('reverts the days field to the stored value after a rejected save', async () => {
    respond(true, { deviceFileReadLevel: null, toolOutputRetentionDays: 14 });
    runAction.mockRejectedValueOnce(new ActionError('rejected', 422));
    render(<PartnerAiDataPolicyCard />);
    const input = (await screen.findByTestId('partner-ai-data-policy-retention')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.blur(input);
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByTestId('partner-ai-data-policy-retention') as HTMLInputElement).value).toBe('14'));
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
