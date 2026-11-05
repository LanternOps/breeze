import { describe, expect, it } from 'vitest';
import { normalizePreviewRow } from './ReportBuilder';

describe('normalizePreviewRow device product number (#9593)', () => {
  it('maps the API productSku onto the Product Number field', () => {
    expect(normalizePreviewRow('devices', { productSku: '5S3F8EA#ABB' }).product_number).toBe('5S3F8EA#ABB');
  });

  it('is null when the device has none', () => {
    expect(normalizePreviewRow('devices', { productSku: null }).product_number).toBeNull();
  });
});
