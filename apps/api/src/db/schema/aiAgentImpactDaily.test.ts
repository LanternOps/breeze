import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { AI_AGENT_IMPACT_COUNTER_KEYS } from '@breeze/shared';
import { aiAgentImpactDaily } from './aiAgentImpactDaily';

describe('ai_agent_impact_daily schema', () => {
  const cfg = getTableConfig(aiAgentImpactDaily);
  it('is named ai_agent_impact_daily with a NOT NULL org_id and day', () => {
    expect(cfg.name).toBe('ai_agent_impact_daily');
    for (const name of ['org_id', 'day', 'rebuilt_at']) {
      expect(cfg.columns.find((c) => c.name === name)?.notNull, name).toBe(true);
    }
  });
  it('carries exactly the ten shared counter keys plus llm_cents, and NO est_seconds_saved', () => {
    const snake = (k: string) => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    const columnNames = new Set(cfg.columns.map((c) => c.name));
    for (const key of AI_AGENT_IMPACT_COUNTER_KEYS) {
      expect(columnNames.has(snake(key)), key).toBe(true);
    }
    expect(columnNames.has('llm_cents')).toBe(true);
    expect(columnNames.has('est_seconds_saved')).toBe(false); // read-time, never stored
  });
});
