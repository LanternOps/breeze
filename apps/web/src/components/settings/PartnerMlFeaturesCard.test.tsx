import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const runAction = vi.hoisted(() => vi.fn());
vi.mock('@/lib/runAction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/runAction')>('@/lib/runAction');
  return { ...actual, runAction };
});
const fetchWithAuth = vi.hoisted(() => vi.fn());
const handleSessionExpired = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth', () => ({ fetchWithAuth, handleSessionExpired }));

import PartnerMlFeaturesCard from './PartnerMlFeaturesCard';

beforeEach(() => {
  vi.clearAllMocks();
  runAction.mockResolvedValue({});
});

describe('PartnerMlFeaturesCard', () => {
  it('renders both switches off when the partner has no ml settings (platform default)', () => {
    const { getByTestId } = render(<PartnerMlFeaturesCard value={undefined} onSaved={vi.fn()} />);
    expect((getByTestId('partner-ml-anomalies-enabled') as HTMLInputElement).checked).toBe(false);
    expect((getByTestId('partner-ml-anomalies-create-alerts') as HTMLInputElement).checked).toBe(false);
  });

  it('PATCHes /orgs/partners/me with the COMPLETE ml.anomalies object when a switch flips', async () => {
    const { getByTestId } = render(
      <PartnerMlFeaturesCard value={{ anomalies: { enabled: false, create_alerts: true } }} onSaved={vi.fn()} />,
    );
    fireEvent.click(getByTestId('partner-ml-anomalies-enabled'));
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
    await runAction.mock.calls[0]![0].request();
    expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me', {
      method: 'PATCH',
      body: JSON.stringify({ settings: { ml: { anomalies: { enabled: true, create_alerts: true } } } }),
    });
  });

  it('reverts the switch when the save fails', async () => {
    const { ActionError } = await import('@/lib/runAction');
    runAction.mockRejectedValue(new ActionError('nope', 403, 'FORBIDDEN'));
    const onSaved = vi.fn();
    const { getByTestId } = render(<PartnerMlFeaturesCard value={undefined} onSaved={onSaved} />);
    fireEvent.click(getByTestId('partner-ml-anomalies-enabled'));
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((getByTestId('partner-ml-anomalies-enabled') as HTMLInputElement).checked).toBe(false),
    );
    expect(onSaved).not.toHaveBeenCalled();
  });
});
