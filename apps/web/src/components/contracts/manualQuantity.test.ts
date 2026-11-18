import { describe, expect, it } from 'vitest';
import { isOnlyManualQuantityError, validationFieldErrors } from './manualQuantity';

const qtyOnly = { error: 'x', details: { formErrors: [], fieldErrors: { manualQuantity: ['bad'] } } };

describe('manualQuantity helpers (#10293)', () => {
  it('validationFieldErrors reads only the shared zValidator shape', () => {
    expect(validationFieldErrors(qtyOnly)).toEqual({ manualQuantity: ['bad'] });
    for (const body of [null, undefined, 'x', [], { error: 'x' }, { details: ['a'] }, { details: { fieldErrors: [] } }]) {
      expect(validationFieldErrors(body)).toBeNull();
    }
  });

  it('isOnlyManualQuantityError is true only for a lone manualQuantity field error', () => {
    expect(isOnlyManualQuantityError(qtyOnly)).toBe(true);
    expect(isOnlyManualQuantityError({ ...qtyOnly, details: { ...qtyOnly.details, formErrors: ['form-level'] } })).toBe(false);
    expect(isOnlyManualQuantityError({ details: { formErrors: [], fieldErrors: { manualQuantity: ['a'], unitPrice: ['b'] } } })).toBe(false);
    expect(isOnlyManualQuantityError({ details: { formErrors: [], fieldErrors: { unitPrice: ['b'] } } })).toBe(false);
    expect(isOnlyManualQuantityError({ error: 'plain 400' })).toBe(false);
    expect(isOnlyManualQuantityError(null)).toBe(false);
  });
});
