import { describe, expect, it, vi } from 'vitest';
import { aiAgentLimitsSchema } from '@breeze/shared';

vi.mock('../../../db', () => ({ db: {}, withSystemDbAccessContext: vi.fn() }));
vi.mock('../../aiAgents/researchProvisioning', () => ({ ensureResearchAgent: vi.fn() }));
vi.mock('../../aiAgents/runService', () => ({ registerAgentRunEnqueuer: vi.fn() }));
vi.mock('../../aiAgents/runLoop', () => ({ executeAgentRun: vi.fn() }));
vi.mock('../../fixMemory/research', () => ({ requestResearch: vi.fn() }));

import { LIFTED_LIMITS } from './runCase';

describe('research eval lifted limits', () => {
  it('pass the production limits validator (an over-max value would ZodError at policy load)', () => {
    expect(aiAgentLimitsSchema.safeParse(LIFTED_LIMITS).success).toBe(true);
  });
  it('are not below the shipped defaults', () => {
    expect(LIFTED_LIMITS.researchQuickBudgetCentsPerRun).toBeGreaterThanOrEqual(5);
    expect(LIFTED_LIMITS.researchDeepBudgetCentsPerRun).toBeGreaterThanOrEqual(25);
  });
});
