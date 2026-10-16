import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SNAPSHOT, CONN, GW, GATEWAY_CONNECTION, jsonRes } from './testFixtures';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import ConnectionDrawer from './ConnectionDrawer';

const connection = SNAPSHOT.connections[1];
const KEY = 'sk-ant-' + 'x'.repeat(40);
const entry = (dataNote: string | null) => [{ entryId: 'e1', slug: 's', name: 'Proxy', dataNote, models: [] }];

beforeEach(() => { fetchWithAuth.mockReset(); showToast.mockReset(); });

describe('ConnectionDrawer', () => {
  it('saves name and geo with one PATCH and closes', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: CONN, configVersion: 3 }));
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<ConnectionDrawer connection={connection} catalog={[]} catalogEnabled={false} onClose={onClose} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('ai-connection-name'), { target: { value: 'Prod' } });
    fireEvent.change(screen.getByTestId('ai-connection-geo'), { target: { value: 'eu' } });
    fireEvent.click(screen.getByTestId('ai-connection-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(`/ai/models/connections/${CONN}`, expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ name: 'Prod', inferenceGeo: 'eu' }),
    })));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSaved).toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('disables Save until something changed', () => {
    render(<ConnectionDrawer connection={connection} catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect((screen.getByTestId('ai-connection-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('rotates the key before patching when a new key is entered', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: CONN })).mockResolvedValueOnce(jsonRes({ id: CONN }));
    render(<ConnectionDrawer connection={connection} catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ai-connection-key'), { target: { value: KEY } });
    fireEvent.change(screen.getByTestId('ai-connection-name'), { target: { value: 'Prod' } });
    fireEvent.click(screen.getByTestId('ai-connection-save'));
    await waitFor(() => expect(fetchWithAuth.mock.calls.map((c) => c[0])).toEqual([
      `/ai/models/connections/${CONN}/key`, `/ai/models/connections/${CONN}`,
    ]));
    expect(fetchWithAuth.mock.calls[0][1].body).toBe(JSON.stringify({ apiKey: KEY }));
  });

  it('never sends a new key and a new endpoint in one Save', () => {
    render(<ConnectionDrawer connection={connection} catalog={entry(null)} catalogEnabled onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ai-connection-key'), { target: { value: KEY } });
    fireEvent.click(screen.getByTestId('ai-connection-endpoint-e1'));
    expect((screen.getByTestId('ai-connection-save') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('ai-connection-one-credential-change')).toBeTruthy();
  });

  it('blocks Save on a catalog endpoint with a data note until consent is checked', () => {
    render(<ConnectionDrawer connection={connection} catalog={entry('May be logged.')} catalogEnabled onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-connection-endpoint-e1'));
    expect((screen.getByTestId('ai-connection-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('ai-connection-datanote-consent'));
    expect((screen.getByTestId('ai-connection-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('posts the endpoint change with the consent flag, then closes', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: CONN }));
    const onClose = vi.fn();
    render(<ConnectionDrawer connection={connection} catalog={entry('May be logged.')} catalogEnabled onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-connection-endpoint-e1'));
    fireEvent.click(screen.getByTestId('ai-connection-datanote-consent'));
    fireEvent.click(screen.getByTestId('ai-connection-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(`/ai/models/connections/${CONN}/endpoint`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ catalogEntryId: 'e1', acknowledgeDataNote: true }),
    })));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(fetchWithAuth).toHaveBeenCalledTimes(1); // no PATCH: name/geo untouched
  });

  it('keeps the escape hatch back to direct Anthropic when pinned to a delisted entry', () => {
    render(<ConnectionDrawer connection={{ ...connection, catalogEntryId: 'gone' }} catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-connection-endpoint-direct'));
    expect((screen.getByTestId('ai-connection-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the drawer open when a save fails (runAction toasted)', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'This conflicts with an existing setting.', code: 'conflict' }, 409));
    const onClose = vi.fn();
    render(<ConnectionDrawer connection={connection} catalog={[]} catalogEnabled={false} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ai-connection-name'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('ai-connection-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('when the key rotated but the PATCH failed: reloads, clears the key draft, and says only the key saved', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonRes({ id: CONN }))
      .mockResolvedValueOnce(jsonRes({ error: 'boom', code: 'write_failed' }, 500))
      .mockResolvedValueOnce(jsonRes({ id: CONN }));
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<ConnectionDrawer connection={connection} catalog={[]} catalogEnabled={false} onClose={onClose} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('ai-connection-key'), { target: { value: KEY } });
    fireEvent.change(screen.getByTestId('ai-connection-name'), { target: { value: 'Prod' } });
    fireEvent.click(screen.getByTestId('ai-connection-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', message: expect.stringContaining('name and region were not') }));
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByTestId('ai-connection-key') as HTMLInputElement).value).toBe('');
    // A retry sends only the PATCH: the key is never rotated twice.
    fireEvent.click(screen.getByTestId('ai-connection-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(3));
    expect(fetchWithAuth.mock.calls[2][0]).toBe(`/ai/models/connections/${CONN}`);
    expect(fetchWithAuth.mock.calls[2][1].method).toBe('PATCH');
  });

  it('when the endpoint changed but the PATCH failed: reloads and a retry does not re-post the endpoint', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonRes({ id: CONN }))
      .mockResolvedValueOnce(jsonRes({ error: 'boom', code: 'write_failed' }, 500))
      .mockResolvedValueOnce(jsonRes({ id: CONN }));
    const onSaved = vi.fn();
    render(<ConnectionDrawer connection={connection} catalog={entry(null)} catalogEnabled onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('ai-connection-endpoint-e1'));
    fireEvent.change(screen.getByTestId('ai-connection-name'), { target: { value: 'Prod' } });
    fireEvent.click(screen.getByTestId('ai-connection-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
    fireEvent.click(screen.getByTestId('ai-connection-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(3));
    expect(fetchWithAuth.mock.calls[2][1].method).toBe('PATCH');
  });

  it('creates a connection (connection=null) with POST /ai/models/connections', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: CONN }, 201));
    const onClose = vi.fn();
    render(<ConnectionDrawer connection={null} catalog={[]} catalogEnabled={false} onClose={onClose} onSaved={vi.fn()} />);
    expect((screen.getByTestId('ai-connection-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('ai-connection-key'), { target: { value: KEY } });
    fireEvent.click(screen.getByTestId('ai-connection-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/ai/models/connections', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ kind: 'anthropic_byok', apiKey: KEY }),
    })));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  describe('gateway create reports whether discovery was queued (#7781)', () => {
    const create = async (discoveryQueued: boolean | undefined) => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: CONN, discoveryQueued }, 201));
      const onClose = vi.fn();
      render(<ConnectionDrawer connection={null} catalog={[]} catalogEnabled={false} initialKind="openai_compatible" onClose={onClose} onSaved={vi.fn()} />);
      fireEvent.change(screen.getByTestId('ai-connection-openai-name'), { target: { value: 'Office vLLM' } });
      fireEvent.change(screen.getByTestId('ai-connection-openai-base-url'), { target: { value: 'https://llm.example.com/v1' } });
      fireEvent.click(screen.getByTestId('ai-connection-save'));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    };
    it('says models are being discovered when queued', async () => {
      await create(true);
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringMatching(/discovering/i) }));
      expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/refresh/i) }));
    });
    it('says discovery could not be queued, and to Refresh, when not', async () => {
      await create(false);
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringMatching(/refresh/i) }));
    });
    it('never claims discovery is running when the flag is absent', async () => {
      await create(undefined);
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringMatching(/refresh/i) }));
    });
  });

  it('disconnect asks for confirmation (no window.confirm) then DELETEs', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ deleted: true }));
    const confirmSpy = vi.spyOn(window, 'confirm');
    const onClose = vi.fn();
    render(<ConnectionDrawer connection={connection} catalog={[]} catalogEnabled={false} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-connection-disconnect'));
    expect(fetchWithAuth).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('ai-connection-disconnect-confirm'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(`/ai/models/connections/${CONN}`, expect.objectContaining({ method: 'DELETE' })));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('refresh queues model discovery via runAction and toasts', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ queued: true, connectionId: CONN }, 202));
    const onClose = vi.fn();
    render(<ConnectionDrawer connection={connection} catalog={[]} catalogEnabled={false} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-connection-refresh'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(`/ai/models/connections/${CONN}/refresh`, expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringMatching(/refresh.*queued/i) })));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('refresh failure (queue unavailable) toasts the localized reason and stays open', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'x', code: 'queue_unavailable' }, 503));
    const onClose = vi.fn();
    render(<ConnectionDrawer connection={connection} catalog={[]} catalogEnabled={false} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-connection-refresh'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/queue/i) })));
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByTestId('ai-connection-refresh') as HTMLButtonElement).disabled).toBe(false);
  });

  it('hides refresh for the platform connection (id null) and in the Add form', () => {
    const { rerender } = render(<ConnectionDrawer connection={SNAPSHOT.connections[0]} catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByTestId('ai-connection-refresh')).toBeNull();
    rerender(<ConnectionDrawer connection={null} catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByTestId('ai-connection-refresh')).toBeNull();
  });
  describe('a refused base URL is a field error on Base URL, not a toast (#7803)', () => {
    const UNREACHABLE = {
      error: 'The endpoint host could not be resolved or reached. Check the base URL.',
      code: 'endpoint_unreachable',
      details: { field: 'baseUrl' },
    };
    const addGateway = (baseUrl: string) => {
      const onClose = vi.fn();
      render(<ConnectionDrawer connection={null} catalog={[]} catalogEnabled={false} initialKind="openai_compatible" onClose={onClose} onSaved={vi.fn()} />);
      fireEvent.change(screen.getByTestId('ai-connection-openai-name'), { target: { value: 'Office vLLM' } });
      fireEvent.change(screen.getByTestId('ai-connection-openai-base-url'), { target: { value: baseUrl } });
      fireEvent.click(screen.getByTestId('ai-connection-save'));
      return onClose;
    };

    it('create: an unresolvable host shows inline on Base URL, keeps the drawer open, and does not toast', async () => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes(UNREACHABLE, 400));
      const onClose = addGateway('http://example.invalid/v1');
      const err = await screen.findByTestId('ai-connection-openai-base-url-error');
      expect(err.textContent).toMatch(/could not be resolved or reached/i);
      expect(err.getAttribute('role')).toBe('alert');
      const input = screen.getByTestId('ai-connection-openai-base-url');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-describedby')).toContain(err.id);
      expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
      expect(onClose).not.toHaveBeenCalled();
    });

    it('create: never renders resolver text, even if a server echoed it', async () => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ ...UNREACHABLE, error: 'getaddrinfo ENOTFOUND example.invalid' }, 400));
      addGateway('http://example.invalid/v1');
      const err = await screen.findByTestId('ai-connection-openai-base-url-error');
      expect(err.textContent).not.toMatch(/getaddrinfo|ENOTFOUND/);
    });

    it('create: an egress-policy refusal keeps the policy message, inline', async () => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'Hosted Breeze only connects to https endpoints.', code: 'egress_blocked' }, 400));
      addGateway('http://llm.example.com/v1');
      const err = await screen.findByTestId('ai-connection-openai-base-url-error');
      expect(err.textContent).toBe('Hosted Breeze only connects to https endpoints.');
      expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });

    it('the error clears once the Base URL is edited, and stays cleared if the old URL is typed back (it was never re-tested)', async () => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes(UNREACHABLE, 400));
      addGateway('http://example.invalid/v1');
      await screen.findByTestId('ai-connection-openai-base-url-error');
      const input = screen.getByTestId('ai-connection-openai-base-url');
      fireEvent.change(input, { target: { value: 'https://llm.example.com/v1' } });
      expect(screen.queryByTestId('ai-connection-openai-base-url-error')).toBeNull();
      expect(input.getAttribute('aria-invalid')).toBeNull();
      fireEvent.change(input, { target: { value: 'http://example.invalid/v1' } });
      expect(screen.queryByTestId('ai-connection-openai-base-url-error')).toBeNull();
    });

    it('a retry that fails for another reason drops the old field error and toasts instead', async () => {
      fetchWithAuth
        .mockResolvedValueOnce(jsonRes(UNREACHABLE, 400))
        .mockResolvedValueOnce(jsonRes({ error: 'busy', code: 'registry_busy' }, 409));
      addGateway('http://example.invalid/v1');
      await screen.findByTestId('ai-connection-openai-base-url-error');
      fireEvent.click(screen.getByTestId('ai-connection-save'));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
      expect(screen.queryByTestId('ai-connection-openai-base-url-error')).toBeNull();
    });

    it('locks the gateway fields while a save is in flight, so a refusal always lands on the URL that was sent', async () => {
      let resolve: (r: Response) => void = () => {};
      fetchWithAuth.mockReturnValueOnce(new Promise<Response>((r) => { resolve = r; }));
      addGateway('http://example.invalid/v1');
      await waitFor(() => expect((screen.getByTestId('ai-connection-openai-base-url') as HTMLInputElement).disabled).toBe(true));
      expect((screen.getByTestId('ai-connection-openai-name') as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByTestId('ai-connection-openai-api-key') as HTMLInputElement).disabled).toBe(true);
      resolve(jsonRes(UNREACHABLE, 400));
      await screen.findByTestId('ai-connection-openai-base-url-error');
      expect((screen.getByTestId('ai-connection-openai-base-url') as HTMLInputElement).disabled).toBe(false);
    });

    it('edit: the endpoint PATCH refusal lands on Base URL too', async () => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes(UNREACHABLE, 400));
      const onClose = vi.fn();
      render(<ConnectionDrawer connection={GATEWAY_CONNECTION} catalog={[]} catalogEnabled={false} onClose={onClose} onSaved={vi.fn()} />);
      fireEvent.change(screen.getByTestId('ai-connection-openai-base-url'), { target: { value: 'http://example.invalid/v1' } });
      fireEvent.click(screen.getByTestId('ai-connection-openai-remove-key'));
      fireEvent.click(screen.getByTestId('ai-connection-save'));
      await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(`/ai/models/connections/${GW}/gateway`, expect.objectContaining({ method: 'PATCH' })));
      expect((await screen.findByTestId('ai-connection-openai-base-url-error')).textContent).toMatch(/could not be resolved or reached/i);
      expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
      expect(onClose).not.toHaveBeenCalled();
    });

    it('a failure that is not about the URL still toasts and leaves Base URL clean', async () => {
      fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'busy', code: 'registry_busy' }, 409));
      addGateway('https://llm.example.com/v1');
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
      expect(screen.queryByTestId('ai-connection-openai-base-url-error')).toBeNull();
    });
  });
});
