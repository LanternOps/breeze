import { describe, it, expect } from 'vitest';
import { resolveActorLabel } from './events';

describe('resolveActorLabel', () => {
  it('returns "Agent" for agent actor type', () => {
    expect(resolveActorLabel('agent', 'some-id')).toBe('Agent');
  });

  it('returns "AI Agent" for ai_agent actor type', () => {
    expect(resolveActorLabel('ai_agent', 'some-id')).toBe('AI Agent');
  });

  it('returns "API Key" for api_key actor type', () => {
    expect(resolveActorLabel('api_key', 'some-id')).toBe('API Key');
  });

  it('returns "System" for system actor type', () => {
    expect(resolveActorLabel('system', 'some-id')).toBe('System');
  });

  it('returns "Unknown" for unrecognized actor type', () => {
    expect(resolveActorLabel('unknown', 'some-id')).toBe('Unknown');
  });

  it('does not return "Unknown" for ai_agent (distinct from agent principal)', () => {
    const result = resolveActorLabel('ai_agent', 'agent-uuid');
    expect(result).toBe('AI Agent');
    expect(result).not.toBe('Unknown');
  });
});
