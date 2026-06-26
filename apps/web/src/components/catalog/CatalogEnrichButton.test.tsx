import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { enrichCatalogItemRequest, showToast } = vi.hoisted(() => ({
  enrichCatalogItemRequest: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock('../../lib/api/catalog', () => ({ enrichCatalogItemRequest }));
vi.mock('../shared/Toast', () => ({ showToast }));

import CatalogEnrichButton from './CatalogEnrichButton';

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function fail(status: number, body: unknown): Response {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

beforeEach(() => { enrichCatalogItemRequest.mockReset(); showToast.mockReset(); });

describe('CatalogEnrichButton', () => {
  const result = {
    draft: {
      name: 'APC UPS', description: 'Battery backup', itemType: 'hardware',
      unitOfMeasure: 'each', taxable: true, taxCategory: null,
    },
    priceGuidance: 'typically $80–120',
    provenance: {
      source: 'ai_enrich', model: 'm', query: 'APC UPS', suggestion: {},
      enrichedAt: '2026-06-25T00:00:00Z', enrichedBy: 'u1',
    },
  };

  it('applies the draft and shows price guidance', async () => {
    enrichCatalogItemRequest.mockResolvedValueOnce(ok({ data: result }));
    const onApply = vi.fn();
    render(<CatalogEnrichButton idSuffix="drawer" hint="hardware" onApply={onApply} />);
    fireEvent.change(screen.getByTestId('catalog-enrich-input-drawer'), { target: { value: 'APC UPS' } });
    fireEvent.click(screen.getByTestId('catalog-enrich-btn-drawer'));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(result));
    expect(enrichCatalogItemRequest).toHaveBeenCalledWith('APC UPS', 'hardware');
    expect(screen.getByTestId('catalog-enrich-guidance-drawer').textContent).toMatch(/80/);
  });

  it('toasts on failure and does not call onApply', async () => {
    enrichCatalogItemRequest.mockResolvedValueOnce(fail(429, { error: 'budget gone', code: 'AI_LIMIT' }));
    const onApply = vi.fn();
    render(<CatalogEnrichButton idSuffix="drawer" onApply={onApply} />);
    fireEvent.change(screen.getByTestId('catalog-enrich-input-drawer'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('catalog-enrich-btn-drawer'));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(onApply).not.toHaveBeenCalled();
  });
});
