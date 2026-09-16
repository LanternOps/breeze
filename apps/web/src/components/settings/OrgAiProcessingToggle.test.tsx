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

import OrgAiProcessingToggle from './OrgAiProcessingToggle';

beforeEach(() => {
  vi.clearAllMocks();
  runAction.mockResolvedValue({});
});

describe('OrgAiProcessingToggle (spec §8, §11)', () => {
  it('renders off by default — external processing is opt-in', () => {
    const { getByTestId } = render(
      <OrgAiProcessingToggle orgId="o1" value={false} onSaved={vi.fn()} />,
    );
    expect((getByTestId('org-ai-external-processing') as HTMLInputElement).checked).toBe(false);
  });

  it('PATCHes the organization through runAction when switched on', async () => {
    const { getByTestId } = render(
      <OrgAiProcessingToggle orgId="o1" value={false} onSaved={vi.fn()} />,
    );
    fireEvent.click(getByTestId('org-ai-external-processing'));
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
    await runAction.mock.calls[0]![0].request();
    expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/organizations/o1', {
      method: 'PATCH',
      body: JSON.stringify({ aiExternalProcessing: true }),
    });
  });

  it('notifies the parent to refetch after a save that landed', async () => {
    const onSaved = vi.fn();
    const { getByTestId } = render(
      <OrgAiProcessingToggle orgId="o1" value={false} onSaved={onSaved} />,
    );
    fireEvent.click(getByTestId('org-ai-external-processing'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('reverts the checkbox when the save fails, so the UI never claims a change that did not land', async () => {
    const { ActionError } = await import('@/lib/runAction');
    runAction.mockRejectedValue(new ActionError('nope', 403, 'FORBIDDEN'));
    const onSaved = vi.fn();
    const { getByTestId } = render(
      <OrgAiProcessingToggle orgId="o1" value={false} onSaved={onSaved} />,
    );
    fireEvent.click(getByTestId('org-ai-external-processing'));
    await waitFor(() =>
      expect((getByTestId('org-ai-external-processing') as HTMLInputElement).checked).toBe(false),
    );
    // A switch left on after a refused save would tell an administrator their
    // customer consented when they did not — and nothing would refetch to undo it.
    expect(onSaved).not.toHaveBeenCalled();
  });
});
