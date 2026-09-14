import { describe, it, expect } from 'vitest';
import { EVENT_TYPES } from '../eventBus';

describe('run progress event type', () => {
  it('is registered on the event bus under the ai.agent namespace', () => {
    expect(EVENT_TYPES.AI_AGENT_RUN_PROGRESS).toBe('ai.agent.run.progress');
  });

  it('keeps the existing completed event name unchanged', () => {
    expect(EVENT_TYPES.AI_AGENT_RUN_COMPLETED).toBe('ai.agent.run.completed');
  });
});
