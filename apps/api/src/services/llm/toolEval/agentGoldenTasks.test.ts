import { describe, expect, it } from 'vitest';
import { getToolAlwaysLoad } from '../../aiTools';
import { toolActionEnum } from '../../aiToolActions';
import { buildAgentRunSystemPrompt, buildAgentRunTaskPrompt } from '../../aiAgents/runnerPrompt';
import { CAPTURE_SURFACES } from '../toolCapture/surfaces';
import { AGENT_GOLDEN_TASKS } from './agentGoldenTasks';

describe('AGENT_GOLDEN_TASKS (#7428)', () => {
  it('is a small set (10–20) with unique ids', () => {
    expect(AGENT_GOLDEN_TASKS.length).toBeGreaterThanOrEqual(10);
    expect(AGENT_GOLDEN_TASKS.length).toBeLessThanOrEqual(20);
    expect(new Set(AGENT_GOLDEN_TASKS.map((t) => t.id)).size).toBe(AGENT_GOLDEN_TASKS.length);
  });

  it('runs every task on an agent surface whose profile matches the task context', () => {
    for (const task of AGENT_GOLDEN_TASKS) {
      expect(CAPTURE_SURFACES[task.surface].agentProfile, task.id).toBe(task.context.profile);
    }
  });

  it('only expects tools the surface actually registers, with declared actions', () => {
    for (const task of AGENT_GOLDEN_TASKS) {
      const surface = CAPTURE_SURFACES[task.surface];
      for (const e of task.expect) {
        const registered = surface.onlyTools!.has(e.tool) || (surface.outcomeTools ?? []).includes(e.tool as never);
        expect(registered, `${task.id}: ${e.tool}`).toBe(true);
        if (e.action) expect(toolActionEnum(e.tool), `${task.id}: ${e.tool}.${e.action}`).toContain(e.action);
      }
    }
  });

  it('renders through the production agent prompt builders', () => {
    for (const task of AGENT_GOLDEN_TASKS) {
      expect(buildAgentRunSystemPrompt(task.context).length, task.id).toBeGreaterThan(200);
      const taskPrompt = buildAgentRunTaskPrompt(task.context);
      expect(taskPrompt, task.id).not.toMatch(/goal is missing/);
      expect(taskPrompt.length, task.id).toBeGreaterThan(40);
    }
  });

  it('mixes tasks answerable by an always-loaded tool with tasks whose every answer is deferred under search', () => {
    const allDeferred = AGENT_GOLDEN_TASKS.filter((t) => t.expect.every((e) => !getToolAlwaysLoad(e.tool)));
    const hotAnswerable = AGENT_GOLDEN_TASKS.filter((t) => t.expect.some((e) => getToolAlwaysLoad(e.tool)));
    expect(allDeferred.length).toBeGreaterThanOrEqual(6);
    expect(hotAnswerable.length).toBeGreaterThanOrEqual(6);
  });
});
