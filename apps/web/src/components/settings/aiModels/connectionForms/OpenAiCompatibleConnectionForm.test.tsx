import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GATEWAY_CONNECTION, jsonRes, GW } from '../testFixtures';

const fetchWithAuth = vi.fn();
vi.mock('../../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../../../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import ConnectionDrawer from '../ConnectionDrawer';

const noop = async () => {};
beforeEach(() => { fetchWithAuth.mockReset(); showToast.mockReset(); });

function fill(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

describe('OpenAI-compatible connection (create)', () => {
  it('POSTs kind/name/baseUrl/apiKey and never sends inferenceGeo', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: GW }, 201));
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<ConnectionDrawer connection={null} initialKind="openai_compatible" catalog={[]} catalogEnabled={false} onClose={onClose} onSaved={onSaved} />);
    fill('ai-connection-openai-name', 'Office vLLM');
    fill('ai-connection-openai-base-url', 'https://llm.example.com/v1');
    fill('ai-connection-openai-api-key', 'sk-local-123');
    fireEvent.click(screen.getByTestId('ai-connection-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    const [url, init] = fetchWithAuth.mock.calls[0]!;
    expect(url).toBe('/ai/models/connections');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ kind: 'openai_compatible', name: 'Office vLLM', baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-local-123' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSaved).toHaveBeenCalled();
  });

  it('omits apiKey when blank (keyless local endpoint)', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: GW }, 201));
    render(<ConnectionDrawer connection={null} initialKind="openai_compatible" catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={noop} />);
    fill('ai-connection-openai-name', 'Ollama');
    fill('ai-connection-openai-base-url', 'http://10.0.0.5:11434/v1');
    fireEvent.click(screen.getByTestId('ai-connection-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(JSON.parse(String(fetchWithAuth.mock.calls[0]![1].body))).toEqual({ kind: 'openai_compatible', name: 'Ollama', baseUrl: 'http://10.0.0.5:11434/v1' });
  });

  it('Save stays disabled until name and a valid http(s) URL are entered (and a short key is rejected)', () => {
    render(<ConnectionDrawer connection={null} initialKind="openai_compatible" catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={noop} />);
    const save = screen.getByTestId('ai-connection-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fill('ai-connection-openai-name', 'x');
    fill('ai-connection-openai-base-url', 'ftp://nope');
    expect(save.disabled).toBe(true);
    fill('ai-connection-openai-base-url', 'https://llm.example.com/v1');
    expect(save.disabled).toBe(false);
    fill('ai-connection-openai-api-key', 'short');
    expect(save.disabled).toBe(true);
    fill('ai-connection-openai-api-key', 'long-enough-key');
    expect(save.disabled).toBe(false);
  });

  it('does not render the inference-region or Anthropic key controls for this kind', () => {
    render(<ConnectionDrawer connection={GATEWAY_CONNECTION} catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={noop} />);
    expect(screen.queryByTestId('ai-connection-geo')).toBeNull();
    expect(screen.queryByTestId('ai-connection-key')).toBeNull();
  });
});

describe('OpenAI-compatible connection (edit)', () => {
  it('a new URL on a connection with a stored key needs a new key or Remove key before Save is enabled', () => {
    render(<ConnectionDrawer connection={GATEWAY_CONNECTION} catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={noop} />);
    const save = screen.getByTestId('ai-connection-save') as HTMLButtonElement;
    expect(screen.queryByTestId('ai-connection-openai-key-required')).toBeNull();
    fill('ai-connection-openai-base-url', 'https://llm2.example.com/v1');
    expect(save.disabled).toBe(true);
    expect(screen.getByTestId('ai-connection-openai-key-required').textContent).toMatch(/key for the new URL/i);
    fill('ai-connection-openai-api-key', 'new-endpoint-key-1');
    expect(save.disabled).toBe(false);
    expect(screen.queryByTestId('ai-connection-openai-key-required')).toBeNull();
    fill('ai-connection-openai-api-key', '');
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('ai-connection-openai-remove-key'));
    expect(save.disabled).toBe(false);
    // Back to the stored URL: no key needed.
    fireEvent.click(screen.getByTestId('ai-connection-openai-remove-key'));
    fill('ai-connection-openai-base-url', 'https://llm.example.com/v1/');
    expect(screen.queryByTestId('ai-connection-openai-key-required')).toBeNull();
  });

  it('PATCHes /gateway with the new URL and the key for it, plus expectedConfigVersion', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: GW }));
    render(<ConnectionDrawer connection={GATEWAY_CONNECTION} catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={noop} />);
    fill('ai-connection-openai-base-url', 'https://llm2.example.com/v1');
    fill('ai-connection-openai-api-key', 'new-endpoint-key-1');
    fireEvent.click(screen.getByTestId('ai-connection-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(`/ai/models/connections/${GW}/gateway`, expect.objectContaining({ method: 'PATCH' })));
    expect(JSON.parse(String(fetchWithAuth.mock.calls[0]![1].body))).toEqual({ baseUrl: 'https://llm2.example.com/v1', apiKey: 'new-endpoint-key-1', expectedConfigVersion: 3 });
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('a keyless connection can move to a new URL without a key', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: GW }));
    render(<ConnectionDrawer connection={{ ...GATEWAY_CONNECTION, keyLast4: null }} catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={noop} />);
    fill('ai-connection-openai-base-url', 'https://llm2.example.com/v1');
    expect(screen.queryByTestId('ai-connection-openai-key-required')).toBeNull();
    fireEvent.click(screen.getByTestId('ai-connection-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(JSON.parse(String(fetchWithAuth.mock.calls[0]![1].body))).toEqual({ baseUrl: 'https://llm2.example.com/v1', expectedConfigVersion: 3 });
  });

  it('Remove key sends apiKey:null', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: GW }));
    render(<ConnectionDrawer connection={GATEWAY_CONNECTION} catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={noop} />);
    fireEvent.click(screen.getByTestId('ai-connection-openai-remove-key'));
    fireEvent.click(screen.getByTestId('ai-connection-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(JSON.parse(String(fetchWithAuth.mock.calls[0]![1].body))).toEqual({ apiKey: null, expectedConfigVersion: 3 });
  });

  it('a new key replaces the stored one; a rename goes through the generic PATCH', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: GW })).mockResolvedValueOnce(jsonRes({ id: GW }));
    render(<ConnectionDrawer connection={GATEWAY_CONNECTION} catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={noop} />);
    fill('ai-connection-openai-api-key', 'rotated-key-99');
    fill('ai-connection-openai-name', 'Renamed');
    fireEvent.click(screen.getByTestId('ai-connection-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
    expect(fetchWithAuth.mock.calls.map((c) => c[0])).toEqual([`/ai/models/connections/${GW}/gateway`, `/ai/models/connections/${GW}`]);
    expect(JSON.parse(String(fetchWithAuth.mock.calls[0]![1].body))).toEqual({ apiKey: 'rotated-key-99', expectedConfigVersion: 3 });
    expect(JSON.parse(String(fetchWithAuth.mock.calls[1]![1].body))).toEqual({ name: 'Renamed' });
  });

  it('Save is disabled until something changed', () => {
    render(<ConnectionDrawer connection={GATEWAY_CONNECTION} catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={noop} />);
    expect((screen.getByTestId('ai-connection-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a failed save surfaces the error on Base URL and keeps the drawer open (#7803)', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'Blocked by policy', code: 'egress_blocked' }, 400));
    const onClose = vi.fn();
    render(<ConnectionDrawer connection={GATEWAY_CONNECTION} catalog={[]} catalogEnabled={false} onClose={onClose} onSaved={noop} />);
    fill('ai-connection-openai-base-url', 'http://169.254.169.254/v1');
    fireEvent.click(screen.getByTestId('ai-connection-openai-remove-key'));
    fireEvent.click(screen.getByTestId('ai-connection-save'));
    expect((await screen.findByTestId('ai-connection-openai-base-url-error')).textContent).toBe('Blocked by policy');
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('an env-managed connection opens read-only with an explanation', () => {
    const conn = { ...GATEWAY_CONNECTION, name: 'Instance endpoint', baseUrl: 'http://10.0.0.5:8000/v1', keyLast4: null, managedBy: 'env' as const };
    render(<ConnectionDrawer connection={conn} catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={noop} />);
    expect((screen.getByTestId('ai-connection-openai-base-url') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('ai-connection-openai-name') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('ai-connection-save') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('ai-connection-openai-env-managed').textContent).toMatch(/MCP_LLM_/);
    expect(screen.queryByTestId('ai-connection-disconnect')).toBeNull();
  });

  it('a released env connection stays read-only but can be disconnected, with its own explanation', () => {
    const conn = { ...GATEWAY_CONNECTION, name: 'Instance endpoint', managedBy: 'env' as const, envReleased: true };
    render(<ConnectionDrawer connection={conn} catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={noop} />);
    expect((screen.getByTestId('ai-connection-openai-base-url') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('ai-connection-openai-api-key') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('ai-connection-save') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('ai-connection-openai-env-managed').textContent).toMatch(/no longer/i);
    expect(screen.getByTestId('ai-connection-disconnect')).toBeTruthy();
  });
});
