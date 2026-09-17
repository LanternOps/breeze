import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const showToast = vi.hoisted(() => vi.fn());
vi.mock('../shared/Toast', () => ({ showToast }));
const fetchWithAuth = vi.hoisted(() => vi.fn());
const handleSessionExpired = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth', () => ({ fetchWithAuth, handleSessionExpired }));

import AttachArtifactToTicket from './AttachArtifactToTicket';

const response = (body: unknown, status = 201) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
function form(ticket = 't-1') {
  const view = render(<AttachArtifactToTicket artifactId="a1" artifactName="results.csv" />);
  fireEvent.click(view.getByTestId('attach-artifact-open-a1'));
  fireEvent.change(view.getByTestId('attach-artifact-ticket-a1'), { target: { value: ticket } });
  const submit = () => fireEvent.click(view.getByTestId('attach-artifact-submit-a1'));
  return { ...view, submit };
}
beforeEach(() => {
  vi.clearAllMocks();
  fetchWithAuth.mockReset();
});

describe('AttachArtifactToTicket', () => {
  it('claims the staged artifact on an internal comment before reporting success', async () => {
    let resolveComment!: (value: Response) => void;
    fetchWithAuth.mockResolvedValueOnce(response({ data: { id: 'att1' } }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveComment = resolve; }));
    const view = form('  t-1  ');
    view.submit();
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
    expect(fetchWithAuth).toHaveBeenNthCalledWith(1, '/tickets/t-1/attachments/from-artifact', {
      method: 'POST', body: JSON.stringify({ handle: 'a1' }),
    });
    expect(fetchWithAuth).toHaveBeenNthCalledWith(2, '/tickets/t-1/comments', {
      method: 'POST', body: JSON.stringify({ content: '', isPublic: false, attachmentIds: ['att1'] }),
    });
    expect(showToast).not.toHaveBeenCalled();
    resolveComment(response({ data: { id: 'comment1' } }));
    await waitFor(() => expect(view.queryByTestId('attach-artifact-ticket-a1')).toBeNull());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it.each(['', '   '])('does not submit an empty ticket id %j', (ticket) => {
    form(ticket).submit();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('surfaces staging failure without posting a comment or reporting success', async () => {
    fetchWithAuth.mockResolvedValueOnce(response({ error: 'Artifact not found' }, 404));
    const view = form();
    view.submit();
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(view.getByTestId('attach-artifact-ticket-a1')).toBeTruthy();
  });

  it('retries a failed comment with the same pending id rather than uploading again', async () => {
    fetchWithAuth.mockResolvedValueOnce(response({ data: { id: 'att1' } }))
      .mockResolvedValueOnce(response({ error: 'Comment unavailable' }, 500))
      .mockResolvedValueOnce(response({ data: { id: 'comment1' } }));
    const view = form();
    view.submit();
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    view.submit();
    await waitFor(() => expect(view.queryByTestId('attach-artifact-ticket-a1')).toBeNull());
    expect(fetchWithAuth).toHaveBeenCalledTimes(3);
    expect(fetchWithAuth.mock.calls[2]).toEqual(fetchWithAuth.mock.calls[1]);
  });

  it('never uses another ticket’s pending attachment when the destination changes', async () => {
    fetchWithAuth.mockResolvedValueOnce(response({ data: { id: 'att1' } }))
      .mockResolvedValueOnce(response({ error: 'Comment unavailable' }, 500))
      .mockResolvedValueOnce(response({ data: { id: 'att2' } }))
      .mockResolvedValueOnce(response({ data: { id: 'comment2' } }));
    const view = form();
    view.submit();
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    fireEvent.change(view.getByTestId('attach-artifact-ticket-a1'), { target: { value: 't-2' } });
    view.submit();
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(4));
    expect(fetchWithAuth).toHaveBeenNthCalledWith(4, '/tickets/t-2/comments', {
      method: 'POST', body: JSON.stringify({ content: '', isPublic: false, attachmentIds: ['att2'] }),
    });
  });

  it('fails visibly if staging succeeds without a usable attachment id', async () => {
    fetchWithAuth.mockResolvedValueOnce(response({ data: {} }));
    form().submit();
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('delegates expired-session handling without an extra error toast', async () => {
    fetchWithAuth.mockResolvedValueOnce(response({ error: 'Unauthorized' }, 401));
    form().submit();
    await waitFor(() => expect(handleSessionExpired).toHaveBeenCalled());
    expect(showToast).not.toHaveBeenCalled();
  });
});
