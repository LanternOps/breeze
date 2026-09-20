import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {} }));

import { releaseMissedRows } from './collectionPublication';

describe('releaseMissedRows', () => {
  it('keeps a relationship that another present row still supports', () => {
    // Two addresses in one prefix on one interface project the same membership.
    const rows = { 'addr-1': ['member'], 'addr-2': ['member'], route: ['default'] };
    expect(releaseMissedRows(rows, ['addr-1'])).toEqual({ remaining: { 'addr-2': ['member'], route: ['default'] }, withdrawn: [] });
  });

  it('withdraws a relationship once its last supporting row is missed', () => {
    const rows = { 'addr-1': ['member'], 'addr-2': ['member'], route: ['default'] };
    expect(releaseMissedRows(rows, ['addr-1', 'addr-2'])).toEqual({ remaining: { route: ['default'] }, withdrawn: ['member'] });
  });

  it('ignores rows that were never published and does not mutate its input', () => {
    const rows = { 'addr-1': ['member'] };
    expect(releaseMissedRows(rows, ['unknown'])).toEqual({ remaining: rows, withdrawn: [] });
    expect(rows).toEqual({ 'addr-1': ['member'] });
  });
});
