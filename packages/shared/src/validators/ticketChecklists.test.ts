import { describe, it, expect } from 'vitest';
import {
  checklistItemCreateSchema,
  checklistItemPatchSchema,
  checklistReorderSchema,
} from './ticketChecklists';

const UUID = '3f2f1d8e-1111-4222-8333-444455556666';

describe('checklistItemCreateSchema', () => {
  it('accepts a label alone', () => {
    expect(checklistItemCreateSchema.parse({ label: 'Check the sign-in log' })).toEqual({
      label: 'Check the sign-in log',
    });
  });

  it('accepts a label with a detail note', () => {
    expect(checklistItemCreateSchema.parse({ label: 'Step', detail: 'Note' })).toEqual({
      label: 'Step',
      detail: 'Note',
    });
  });

  it('rejects an empty label', () => {
    expect(checklistItemCreateSchema.safeParse({ label: '' }).success).toBe(false);
  });

  it('rejects a label over 500 characters', () => {
    expect(checklistItemCreateSchema.safeParse({ label: 'x'.repeat(501) }).success).toBe(false);
  });

  it('rejects unknown keys, including a forged attestation', () => {
    expect(
      checklistItemCreateSchema.safeParse({ label: 'Step', doneAt: new Date().toISOString() }).success,
    ).toBe(false);
    expect(checklistItemCreateSchema.safeParse({ label: 'Step', position: 3 }).success).toBe(false);
  });
});

describe('checklistItemPatchSchema', () => {
  it('accepts done on its own', () => {
    expect(checklistItemPatchSchema.parse({ done: true })).toEqual({ done: true });
  });

  it('accepts clearing detail to null', () => {
    expect(checklistItemPatchSchema.parse({ detail: null })).toEqual({ detail: null });
  });

  it('rejects an empty patch', () => {
    // An empty body would otherwise be a silent 200 that changed nothing.
    expect(checklistItemPatchSchema.safeParse({}).success).toBe(false);
  });

  it('REJECTS doneAt and doneByUserId from the request body', () => {
    // The attestation is computed server-side from the authenticated principal
    // and now(). Accepting either from the body would let a caller forge who
    // performed a compliance step, and when.
    expect(checklistItemPatchSchema.safeParse({ doneAt: new Date().toISOString() }).success).toBe(false);
    expect(checklistItemPatchSchema.safeParse({ doneByUserId: UUID }).success).toBe(false);
    expect(checklistItemPatchSchema.safeParse({ done: true, doneByUserId: UUID }).success).toBe(false);
  });

  it('rejects position — ordering is whole-list only', () => {
    expect(checklistItemPatchSchema.safeParse({ position: 3 }).success).toBe(false);
  });

  it('rejects an empty label on a patch too', () => {
    expect(checklistItemPatchSchema.safeParse({ label: '' }).success).toBe(false);
  });
});

describe('checklistReorderSchema', () => {
  it('accepts a non-empty id list', () => {
    expect(checklistReorderSchema.parse({ itemIds: [UUID] })).toEqual({ itemIds: [UUID] });
  });

  it('rejects an empty list', () => {
    expect(checklistReorderSchema.safeParse({ itemIds: [] }).success).toBe(false);
  });

  it('rejects a non-uuid id', () => {
    expect(checklistReorderSchema.safeParse({ itemIds: ['nope'] }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(checklistReorderSchema.safeParse({ itemIds: [UUID], ticketId: UUID }).success).toBe(false);
  });
});
