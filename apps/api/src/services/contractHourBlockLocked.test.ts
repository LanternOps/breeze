import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { updateContractLineSchema } from '@breeze/shared';
import { stampedKeysFromZod, stampedKeysErrorBody } from './contractHourBlockLocked';

const failure = (body: unknown) => { const r = updateContractLineSchema.safeParse(body); if (r.success) throw new Error('expected failure'); return r.error; };

describe('server-stamped block columns on a line patch (#4547 W03)', () => {
  it('names exactly the stamped keys the strict schema refused', () => {
    expect(stampedKeysFromZod(failure({ hourBlockFirstPeriodStart: '2026-01-01' }))).toEqual(['hourBlockFirstPeriodStart']);
    expect(stampedKeysFromZod(failure({ hourBlockRetiredAt: 'x', hourBlockFirstPeriodStart: 'y' })).sort()).toEqual(['hourBlockFirstPeriodStart', 'hourBlockRetiredAt']);
  });
  it('ignores other unknown keys and other failures', () => {
    expect(stampedKeysFromZod(failure({ lineType: 'flat' }))).toEqual([]);
    expect(stampedKeysFromZod(failure({ unitPrice: 'abc' }))).toEqual([]);
  });
  it('builds the 400 body only when a stamped key is involved', () => {
    expect(stampedKeysErrorBody(failure({ hourBlockRetiredAt: 'x' }))).toMatchObject({ code: 'HOUR_BLOCK_FIELD_LOCKED', details: { fields: ['hourBlockRetiredAt'] } });
    expect(stampedKeysErrorBody(failure({ lineType: 'flat' }))).toBeNull();
    expect(stampedKeysErrorBody(new Error('boom'))).toBeNull();
    expect(stampedKeysErrorBody(new z.ZodError([]))).toBeNull();
  });
});
