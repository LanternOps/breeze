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
  it('renders the Suggested fixes switch from settings.ml.remediation_suggestions (#6934)', () => {
    const { getByTestId } = render(
      <PartnerMlFeaturesCard value={{ remediation_suggestions: { enabled: true } }} onSaved={vi.fn()} />,
    );
    expect((getByTestId('partner-ml-remediation-suggestions-enabled') as HTMLInputElement).checked).toBe(true);
  });

  it('PATCHes ONLY ml.remediation_suggestions when the Suggested fixes switch flips, never the anomalies block (#6934)', async () => {
    const onSaved = vi.fn();
    const { getByTestId } = render(
      <PartnerMlFeaturesCard value={{ anomalies: { enabled: true, create_alerts: true } }} onSaved={onSaved} />,
    );
    fireEvent.click(getByTestId('partner-ml-remediation-suggestions-enabled'));
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
    await runAction.mock.calls[0]![0].request();
    expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me', {
      method: 'PATCH',
      body: JSON.stringify({ settings: { ml: { remediation_suggestions: { enabled: true } } } }),
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect((getByTestId('partner-ml-anomalies-enabled') as HTMLInputElement).checked).toBe(true);
  });

  it('reverts the Suggested fixes switch when the save fails (#6934)', async () => {
    const { ActionError } = await import('@/lib/runAction');
    runAction.mockRejectedValue(new ActionError('nope', 403, 'FORBIDDEN'));
    const { getByTestId } = render(<PartnerMlFeaturesCard value={undefined} onSaved={vi.fn()} />);
    fireEvent.click(getByTestId('partner-ml-remediation-suggestions-enabled'));
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((getByTestId('partner-ml-remediation-suggestions-enabled') as HTMLInputElement).checked).toBe(false),
    );
  });
});
