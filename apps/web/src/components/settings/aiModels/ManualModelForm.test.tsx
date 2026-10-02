import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { jsonRes, GW } from './testFixtures';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import ManualModelForm from './ManualModelForm';

beforeEach(() => { fetchWithAuth.mockReset(); showToast.mockReset(); });

const fill = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } });

describe('ManualModelForm', () => {
  it('disables Save for an empty or invalid model id', () => {
    render(<ManualModelForm connectionId={GW} onSaved={vi.fn()} onClose={vi.fn()} />);
    const save = screen.getByTestId('ai-manual-model-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fill('ai-manual-model-id', 'has space');
    expect(save.disabled).toBe(true);
    fill('ai-manual-model-id', 'qwen2.5-coder:7b');
    expect(save.disabled).toBe(false);
  });

  it('POSTs modelId (and displayName when given) and closes', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: 'o1' }, 201));
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<ManualModelForm connectionId={GW} onSaved={onSaved} onClose={onClose} />);
    fill('ai-manual-model-id', 'qwen2.5-coder:7b');
    fill('ai-manual-model-name', 'Qwen Coder');
    fireEvent.click(screen.getByTestId('ai-manual-model-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(`/ai/models/connections/${GW}/offerings`, expect.objectContaining({ method: 'POST' })));
    expect(JSON.parse(String(fetchWithAuth.mock.calls[0]![1].body))).toEqual({ modelId: 'qwen2.5-coder:7b', displayName: 'Qwen Coder' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSaved).toHaveBeenCalled();
  });

  it('sends prices only when all four are filled (cents per 1M tokens)', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: 'o1' }, 201));
    render(<ManualModelForm connectionId={GW} onSaved={vi.fn()} onClose={vi.fn()} />);
    fill('ai-manual-model-id', 'm1');
    fill('ai-manual-model-price-input', '10');
    expect((screen.getByTestId('ai-manual-model-save') as HTMLButtonElement).disabled).toBe(true);
    fill('ai-manual-model-price-output', '20');
    fill('ai-manual-model-price-cache-read', '1');
    fill('ai-manual-model-price-cache-write', '12');
    fireEvent.click(screen.getByTestId('ai-manual-model-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(JSON.parse(String(fetchWithAuth.mock.calls[0]![1].body))).toEqual({
      modelId: 'm1', prices: { inputCentsPerM: 10, outputCentsPerM: 20, cacheReadCentsPerM: 1, cacheWriteCentsPerM: 12 },
    });
  });

  it('a 409 duplicate_model shows the mapped message and keeps the form open', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'x', code: 'duplicate_model' }, 409));
    const onClose = vi.fn();
    render(<ManualModelForm connectionId={GW} onSaved={vi.fn()} onClose={onClose} />);
    fill('ai-manual-model-id', 'm1');
    fireEvent.click(screen.getByTestId('ai-manual-model-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/already/i) })));
    expect(onClose).not.toHaveBeenCalled();
  });
});
