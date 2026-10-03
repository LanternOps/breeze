import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { AI_MODEL_FIELDS_RETIRED_IN, retiredAiModelField, retiredAiModelFieldMessage } from './retiredAiModelFields';

describe('retired AI model fields (W08)', () => {
  const schema = z.object({ name: z.string().optional(), reviewerModel: retiredAiModelField('reviewerModel') }).strict();

  it('rejects the field with any value, including null, naming the replacement', () => {
    for (const value of ['claude-x', null, '']) {
      const r = schema.safeParse({ reviewerModel: value });
      expect(r.success).toBe(false);
      expect(r.error!.issues[0]!.message).toBe(retiredAiModelFieldMessage('reviewerModel'));
    }
  });

  it('rejects the field on a non-strict object too (declared, so never silently stripped)', () => {
    const loose = z.object({ name: z.string().optional(), allowedModels: retiredAiModelField('allowedModels') });
    const r = loose.safeParse({ name: 'x', allowedModels: ['claude-x'] });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(['allowedModels']);
  });

  it('accepts a body without it, and the parsed type has no such key', () => {
    expect(schema.parse({ name: 'x' })).toEqual({ name: 'x' });
  });

  it('names the version and the /ai/models replacement', () => {
    expect(retiredAiModelFieldMessage('reviewerModel')).toContain(`retired in v${AI_MODEL_FIELDS_RETIRED_IN}`);
    expect(retiredAiModelFieldMessage('reviewerModel')).toContain('script_reviewer');
    expect(retiredAiModelFieldMessage('allowedModels')).toContain('office_chat');
    expect(retiredAiModelFieldMessage('model')).toContain('offeringId');
  });
});
