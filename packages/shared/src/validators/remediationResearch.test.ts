// packages/shared/src/validators/remediationResearch.test.ts
import { describe, expect, it } from 'vitest';
import {
  AI_AGENT_KINDS, AI_AGENT_LIMIT_DEFAULTS, AI_AGENT_POLICY_SNAPSHOT_VERSION, AI_AGENT_RUN_PROFILES,
  RESEARCH_BUILTIN_ACTIONS, RESEARCH_BUILTIN_PARAM_SCHEMAS, RESEARCH_EDITABLE_LIMIT_KEYS, aiAgentLimitsPatchSchema, allowedModesForKind,
  createAiAgentSchema, researchSubmissionSchema,
} from '../index';

const base = { title: 'Restart the spooler', reasoning: 'The spooler service is stopped and the alert names it.', riskTier: 'low' as const };

describe('research contract', () => {
  it('adds the kind, the profile and a v16 snapshot', () => {
    expect(AI_AGENT_KINDS).toContain('research');
    expect(AI_AGENT_RUN_PROFILES).toContain('remediation_research');
    expect(AI_AGENT_POLICY_SNAPSHOT_VERSION).toBe(16);
    expect(allowedModesForKind('research')).toEqual(['off', 'act']);
  });

  it('pins the spec cap defaults (ceilings until the eval, Task 22)', () => {
    expect(AI_AGENT_LIMIT_DEFAULTS).toMatchObject({
      researchQuickMaxTurns: 4, researchDeepMaxTurns: 10,
      researchQuickBudgetCentsPerRun: 5, researchDeepBudgetCentsPerRun: 25,
      maxConcurrentResearchRuns: 2, maxResearchRunsPerHour: 30, maxAutoResearchRunsPerHour: 6,
    });
    expect(RESEARCH_EDITABLE_LIMIT_KEYS).toContain('researchDeepBudgetCentsPerRun');
  });

  it('bounds research limits', () => {
    expect(aiAgentLimitsPatchSchema.safeParse({ researchQuickMaxTurns: 11 }).success).toBe(false);
    expect(aiAgentLimitsPatchSchema.safeParse({ researchDeepBudgetCentsPerRun: 0 }).success).toBe(false);
    expect(aiAgentLimitsPatchSchema.safeParse({ researchDeepBudgetCentsPerRun: 100 }).success).toBe(true);
  });

  it('research agents are never created at partner level by a user (provisioned only)', () => {
    const r = createAiAgentSchema.safeParse({ kind: 'research', name: 'x', mode: 'act', ownerScope: 'partner' });
    expect(r.success).toBe(false);
    const org = createAiAgentSchema.safeParse({ kind: 'research', name: 'x', mode: 'act', ownerScope: 'organization', orgId: '11111111-1111-4111-8111-111111111111' });
    expect(org.success).toBe(true);
  });
});

describe('researchSubmissionSchema', () => {
  it('accepts every item kind', () => {
    const parsed = researchSubmissionSchema.parse({
      summary: 'Spooler stopped after a driver update.',
      items: [
        { kind: 'catalog', ref: { type: 'script', id: '11111111-1111-4111-8111-111111111111' }, ...base },
        { kind: 'builtin_action', action: 'restart_service', params: { serviceName: 'Spooler' }, ...base },
        { kind: 'builtin_action', action: 'kill_process', params: { processName: 'spoolsv.exe' }, ...base },
        { kind: 'builtin_action', action: 'reboot', params: {}, ...base },
        { kind: 'builtin_action', action: 'disk_cleanup', params: { actionIds: ['win_cleanmgr'] }, ...base },
        { kind: 'manual_steps', steps: ['Open Services', 'Restart Print Spooler'], ...base },
      ],
    });
    expect(parsed.items).toHaveLength(6);
    // RESEARCH_MAX_ITEMS is 6, so the seventh kind is parsed separately.
    expect(researchSubmissionSchema.parse({
      summary: 's',
      items: [{ kind: 'draft_request', brief: 'Clear the spooler queue then restart it', language: 'powershell', ...base }],
    }).items).toHaveLength(1);
    expect(RESEARCH_BUILTIN_ACTIONS).toEqual(['reboot', 'restart_service', 'kill_process', 'disk_cleanup']);
  });

  it('rejects an action outside the allowlist, bad params and smuggled keys', () => {
    expect(researchSubmissionSchema.safeParse({ summary: 's', items: [{ kind: 'builtin_action', action: 'format_disk', params: {}, ...base }] }).success).toBe(false);
    expect(researchSubmissionSchema.safeParse({ summary: 's', items: [{ kind: 'builtin_action', action: 'restart_service', params: {}, ...base }] }).success).toBe(false);
    expect(researchSubmissionSchema.safeParse({ summary: 's', items: [{ kind: 'manual_steps', steps: ['a'], execute: true, ...base }] }).success).toBe(false);
  });

  it('caps items, steps and text sizes', () => {
    const many = Array.from({ length: 7 }, () => ({ kind: 'manual_steps', steps: ['a'], ...base }));
    expect(researchSubmissionSchema.safeParse({ summary: 's', items: many }).success).toBe(false);
    expect(researchSubmissionSchema.safeParse({ summary: 's', items: [{ kind: 'manual_steps', steps: Array(13).fill('a'), ...base }] }).success).toBe(false);
  });

  it('an empty item list is valid (no safe fix)', () => {
    expect(researchSubmissionSchema.parse({ summary: 'Nothing safe to suggest.', items: [] }).items).toEqual([]);
  });
});

describe('RESEARCH_BUILTIN_PARAM_SCHEMAS', () => {
  it('has one strict schema per built-in action', () => {
    expect(Object.keys(RESEARCH_BUILTIN_PARAM_SCHEMAS).sort()).toEqual([...RESEARCH_BUILTIN_ACTIONS].sort());
    expect(RESEARCH_BUILTIN_PARAM_SCHEMAS.reboot.safeParse({ force: true }).success).toBe(false);
    expect(RESEARCH_BUILTIN_PARAM_SCHEMAS.restart_service.safeParse({ serviceName: 'Spooler' }).success).toBe(true);
    expect(RESEARCH_BUILTIN_PARAM_SCHEMAS.restart_service.safeParse({ serviceName: '' }).success).toBe(false);
    expect(RESEARCH_BUILTIN_PARAM_SCHEMAS.disk_cleanup.safeParse({ actionIds: [] }).success).toBe(false);
  });
});
