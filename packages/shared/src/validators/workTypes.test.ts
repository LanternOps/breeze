// packages/shared/src/validators/workTypes.test.ts
import { describe, expect, it } from 'vitest';
import { createWorkTypeSchema, updateWorkTypeSchema } from './workTypes';

describe('createWorkTypeSchema', () => {
  it('accepts a plain name', () => {
    expect(createWorkTypeSchema.parse({ name: 'On-site' })).toEqual({ name: 'On-site' });
  });
  it('trims surrounding whitespace so " Remote " cannot collide-by-invisibility with "Remote"', () => {
    expect(createWorkTypeSchema.parse({ name: '  Remote  ' }).name).toBe('Remote');
  });
  it('rejects a blank or whitespace-only name', () => {
    expect(createWorkTypeSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(createWorkTypeSchema.safeParse({ name: '' }).success).toBe(false);
  });
  it('rejects a name longer than 60 characters', () => {
    expect(createWorkTypeSchema.safeParse({ name: 'x'.repeat(61) }).success).toBe(false);
  });
  it('does not accept isActive on create — a new work type is always active', () => {
    expect(createWorkTypeSchema.parse({ name: 'Remote', isActive: false })).toEqual({ name: 'Remote' });
  });
});

describe('updateWorkTypeSchema', () => {
  it('allows a partial patch', () => {
    expect(updateWorkTypeSchema.parse({ isActive: false })).toEqual({ isActive: false });
  });
  it('rejects an empty patch object', () => {
    expect(updateWorkTypeSchema.safeParse({}).success).toBe(false);
  });
});
