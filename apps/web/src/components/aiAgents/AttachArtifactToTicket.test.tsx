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

import AttachArtifactToTicket from './AttachArtifactToTicket';

beforeEach(() => {
  vi.clearAllMocks();
  runAction.mockResolvedValue({ data: { id: 'att1' } });
});

describe('AttachArtifactToTicket (spec §6.3)', () => {
  it('posts the handle to the ticket through runAction', async () => {
    const { getByTestId } = render(
      <AttachArtifactToTicket artifactId="a1" artifactName="failed-logons.csv" />,
    );
    fireEvent.click(getByTestId('attach-artifact-open-a1'));
    fireEvent.change(getByTestId('attach-artifact-ticket-a1'), { target: { value: 't-1' } });
    fireEvent.click(getByTestId('attach-artifact-submit-a1'));

    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
    const opts = runAction.mock.calls[0]![0];
    await opts.request();
    expect(fetchWithAuth).toHaveBeenCalledWith('/tickets/t-1/attachments/from-artifact', {
      method: 'POST',
      body: JSON.stringify({ handle: 'a1' }),
    });
  });

  it('does not submit an empty ticket id', () => {
    const { getByTestId } = render(<AttachArtifactToTicket artifactId="a1" artifactName="f.csv" />);
    fireEvent.click(getByTestId('attach-artifact-open-a1'));
    fireEvent.click(getByTestId('attach-artifact-submit-a1'));
    expect(runAction).not.toHaveBeenCalled();
  });

  it('trims a padded ticket id rather than posting to a whitespace path', () => {
    const { getByTestId } = render(<AttachArtifactToTicket artifactId="a1" artifactName="f.csv" />);
    fireEvent.click(getByTestId('attach-artifact-open-a1'));
    fireEvent.change(getByTestId('attach-artifact-ticket-a1'), { target: { value: '   ' } });
    fireEvent.click(getByTestId('attach-artifact-submit-a1'));
    expect(runAction).not.toHaveBeenCalled();
  });

  it('lets the auth redirect handle a 401 and swallows an already-toasted ActionError', async () => {
    const { ActionError } = await import('@/lib/runAction');
    runAction.mockRejectedValue(new ActionError('nope', 403, 'FORBIDDEN'));
    const { getByTestId } = render(<AttachArtifactToTicket artifactId="a1" artifactName="f.csv" />);
    fireEvent.click(getByTestId('attach-artifact-open-a1'));
    fireEvent.change(getByTestId('attach-artifact-ticket-a1'), { target: { value: 't-1' } });
    fireEvent.click(getByTestId('attach-artifact-submit-a1'));
    await waitFor(() => expect(runAction).toHaveBeenCalled());
    // No rethrow, no crash: runAction already toasted it. The form stays open so
    // the technician can correct the ticket id rather than retyping it.
    expect(getByTestId('attach-artifact-ticket-a1')).toBeTruthy();
  });
});
