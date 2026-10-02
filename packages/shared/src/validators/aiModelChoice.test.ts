import { describe, expect, it } from 'vitest';
import {
  agentModelChoicesQuerySchema,
  aiModelChoiceSchema,
  chatModelChoicesQuerySchema,
  continueAiSessionSchema,
} from './aiModelChoice';
import { offeringOptionsSchema } from './aiModelOptions';
import { createAiSessionSchema, sendAiMessageSchema } from './ai';

const OFF = '0b8f1f2e-6a1c-4c55-9a39-6a7f1e1c0a01';
const ORG = '0b8f1f2e-6a1c-4c55-9a39-6a7f1e1c0b01';

describe('offeringOptionsSchema.budgetThinking', () => {
  it('accepts off and on', () => {
    expect(offeringOptionsSchema.parse({ budgetThinking: 'on' })).toEqual({ budgetThinking: 'on' });
    expect(offeringOptionsSchema.parse({ budgetThinking: 'off' })).toEqual({ budgetThinking: 'off' });
  });
  it('rejects any other value', () => {
    expect(offeringOptionsSchema.safeParse({ budgetThinking: true }).success).toBe(false);
    expect(offeringOptionsSchema.safeParse({ budgetThinking: 'auto' }).success).toBe(false);
  });
});

describe('aiModelChoiceSchema', () => {
  it('requires an offering id', () => {
    expect(aiModelChoiceSchema.safeParse({ options: { effort: 'high' } }).success).toBe(false);
  });
  it('accepts an offering with partial options', () => {
    expect(aiModelChoiceSchema.parse({ offeringId: OFF, options: { effort: 'high', speed: 'fast' } }))
      .toEqual({ offeringId: OFF, options: { effort: 'high', speed: 'fast' } });
  });
  it('is strict: a free-form model id is rejected, never ignored', () => {
    expect(aiModelChoiceSchema.safeParse({ offeringId: OFF, model: 'some-model' }).success).toBe(false);
  });
  it('rejects a non-uuid offering', () => {
    expect(aiModelChoiceSchema.safeParse({ offeringId: 'opus' }).success).toBe(false);
  });
});

describe('chatModelChoicesQuerySchema', () => {
  it('accepts neither, a session, or an org', () => {
    expect(chatModelChoicesQuerySchema.safeParse({}).success).toBe(true);
    expect(chatModelChoicesQuerySchema.safeParse({ sessionId: OFF }).success).toBe(true);
    expect(chatModelChoicesQuerySchema.safeParse({ orgId: ORG }).success).toBe(true);
  });
  it('rejects both at once', () => {
    expect(chatModelChoicesQuerySchema.safeParse({ sessionId: OFF, orgId: ORG }).success).toBe(false);
  });
});

describe('agentModelChoicesQuerySchema', () => {
  it('accepts an optional org (absent = partner-wide agent)', () => {
    expect(agentModelChoicesQuerySchema.safeParse({}).success).toBe(true);
    expect(agentModelChoicesQuerySchema.safeParse({ orgId: ORG }).success).toBe(true);
  });
});

describe('continueAiSessionSchema', () => {
  it('requires a model choice', () => {
    expect(continueAiSessionSchema.safeParse({}).success).toBe(false);
    expect(continueAiSessionSchema.parse({ model: { offeringId: OFF } })).toEqual({ model: { offeringId: OFF } });
  });
});

describe('message and session schemas (W05)', () => {
  it('a message may carry a model choice', () => {
    expect(sendAiMessageSchema.parse({ content: 'hi', model: { offeringId: OFF } }).model).toEqual({ offeringId: OFF });
  });
  it('a message without a model choice is unchanged', () => {
    expect(sendAiMessageSchema.parse({ content: 'hi' })).toEqual({ content: 'hi' });
  });
  it('session create no longer carries the free-form model (W03 deprecation, removed in W05)', () => {
    const parsed = createAiSessionSchema.parse({ model: 'claude-opus-5-5' } as Record<string, unknown>);
    expect(parsed).not.toHaveProperty('model');
  });
});
