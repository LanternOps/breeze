import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_ROWS, MAX_IMPORT_VALUES } from './customFieldImport';

describe('custom-field import caps', () => {
  it('caps rows per request at 1000', () => {
    expect(MAX_IMPORT_ROWS).toBe(1000);
  });

  it('caps values per request at 5000, higher than the row cap', () => {
    expect(MAX_IMPORT_VALUES).toBe(5000);
    expect(MAX_IMPORT_VALUES).toBeGreaterThan(MAX_IMPORT_ROWS);
  });
});
