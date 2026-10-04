import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ResearchSuggestionItem } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents, devices, fixInstructions, remediationSuggestions, scripts } from '../../db/schema';
import { persistResearchSuggestions } from '../../services/fixMemory/researchPersist';
import type { ResearchRunContext } from '../../services/aiAgents/researchContext';
import { setupTestEnvironment } from './db-utils';

const base = { title: 'Fix it', reasoning: 'Because.', riskTier: 'medium' as const };

async function seed() {
  const env = await setupTestEnvironment();
  return withSystemDbAccessContext(async () => {
    const orgId = env.organization.id;
    const [device] = await db.insert(devices).values({
      orgId, siteId: env.site.id, agentId: `rp-${randomUUID()}`, hostname: 'WS-RP', osType: 'windows',
      osVersion: 'test', architecture: 'x86_64', agentVersion: 'test', status: 'online', enrolledAt: new Date(),
    }).returning({ id: devices.id });
    const [script] = await db.insert(scripts).values({
      orgId, name: 'Restart spooler', osTypes: ['windows'], language: 'powershell', content: 'Restart-Service Spooler',
    }).returning({ id: scripts.id });
    const [agent] = await db.insert(aiAgents)
      .values({ orgId, partnerId: null, kind: 'triage', name: 'Research persist agent', createdBy: env.user.id })
      .returning({ id: aiAgents.id });
    const mkRun = async () => {
      const [run] = await db.insert(aiAgentRuns).values({
        agentId: agent!.id, orgId, triggerKind: 'alert', dedupeKey: `rp-${randomUUID()}`,
        modeAtStart: 'shadow', policySnapshot: { schemaVersion: 1 } as never,
      }).returning({ id: aiAgentRuns.id });
      return run!.id;
    };
    const sourceId = randomUUID();
    const research = {
      depth: 'quick', source: { sourceType: 'rca', sourceId, title: null, severity: null, message: null },
      device: { id: device!.id, hostname: 'WS-RP', osType: 'windows' }, signature: null, memory: null,
      catalog: { scripts: [{ id: script!.id, name: 'Restart spooler', description: null }], playbooks: [], cleanupActionIds: [] },
      refs: { deviceOs: 'windows', scriptIds: new Set([script!.id]), scriptIdsAnyOs: new Set([script!.id]), playbookIds: new Set() },
    } as unknown as ResearchRunContext;
    return { orgId, partnerId: env.partner.id, deviceId: device!.id, scriptId: script!.id, sourceId, research, runA: await mkRun(), runB: await mkRun() };
  });
}

const persist = (s: Awaited<ReturnType<typeof seed>>, runId: string, items: ResearchSuggestionItem[]) =>
  withSystemDbAccessContext(() => persistResearchSuggestions({
    runId, orgId: s.orgId, research: s.research,
    outcome: { summary: 's', items, rejected: [], noSafeFix: items.length === 0 },
  }));

const rowsFor = (sourceId: string) => withSystemDbAccessContext(() =>
  db.select().from(remediationSuggestions).where(eq(remediationSuggestions.sourceId, sourceId)));

describe('research suggestion persistence (real PG)', () => {
  it('one row per target kind persists with every CHECK satisfied (incl. max-size multi-byte steps)', async () => {
    const s = await seed();
    const items: ResearchSuggestionItem[] = [
      { kind: 'catalog', ref: { type: 'script', id: s.scriptId }, ...base },
      { kind: 'builtin_action', action: 'restart_service', params: { serviceName: 'Spooler' }, ...base },
      // 12 x 400 'é' = 9600 bytes would be rejected upstream; 12 x 300 stays legal and large.
      { kind: 'manual_steps', steps: Array(12).fill('é'.repeat(300)), ...base },
      { kind: 'draft_request', brief: '日'.repeat(2000), language: 'powershell', ...base },
    ];
    await expect(persist(s, s.runA, items)).resolves.toEqual({ inserted: 4 });
    const rows = (await rowsFor(s.sourceId)).sort((a, b) => a.researchOrdinal! - b.researchOrdinal!);
    expect(rows.map((r) => r.targetType)).toEqual(['script', 'builtin_action', 'manual_steps', 'script_draft']);
    expect(rows.every((r) => r.origin === 'ai_research' && r.agentRunId === s.runA && r.confidence === null)).toBe(true);
  });

  it('a research script row duplicating a memory script row for the same source is a no-op', async () => {
    const s = await seed();
    await withSystemDbAccessContext(() => db.insert(remediationSuggestions).values({
      orgId: s.orgId, sourceType: 'rca', sourceId: s.sourceId, targetType: 'script', scriptId: s.scriptId,
      title: 'memory', rationale: 'proven', expectedAction: 'run', origin: 'memory',
    }));
    await expect(persist(s, s.runA, [{ kind: 'catalog', ref: { type: 'script', id: s.scriptId }, ...base }])).resolves.toEqual({ inserted: 0 });
    const rows = await rowsFor(s.sourceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('memory');
  });

  it('replaying the same run ordinals is a no-op', async () => {
    const s = await seed();
    const items: ResearchSuggestionItem[] = [{ kind: 'manual_steps', steps: ['a'], ...base }];
    await expect(persist(s, s.runA, items)).resolves.toEqual({ inserted: 1 });
    await expect(persist(s, s.runA, items)).resolves.toEqual({ inserted: 0 });
    expect(await rowsFor(s.sourceId)).toHaveLength(1);
  });

  it('builtin and instructions research rows are not deduped against memory rows for the same source', async () => {
    const s = await seed();
    await withSystemDbAccessContext(async () => {
      const [ins] = await db.insert(fixInstructions).values({ partnerId: s.partnerId, title: 'Reviewed', steps: ['a'] }).returning({ id: fixInstructions.id });
      await db.insert(remediationSuggestions).values([
        { orgId: s.orgId, sourceType: 'rca', sourceId: s.sourceId, targetType: 'builtin_action', builtinAction: 'reboot',
          title: 'memory reboot', rationale: 'proven', expectedAction: 'reboot', origin: 'memory' },
        { orgId: s.orgId, sourceType: 'rca', sourceId: s.sourceId, targetType: 'manual_steps', instructionsId: ins!.id,
          title: 'memory steps', rationale: 'proven', expectedAction: 'steps', origin: 'memory' },
      ]);
    });
    await expect(persist(s, s.runA, [
      { kind: 'builtin_action', action: 'reboot', params: {}, ...base },
      { kind: 'manual_steps', steps: ['a'], ...base },
    ])).resolves.toEqual({ inserted: 2 });
    expect(await rowsFor(s.sourceId)).toHaveLength(4);
  });

  it('a forced mid-batch failure leaves zero rows (atomic inside one system context)', async () => {
    const s = await seed();
    const bad = { kind: 'catalog', ref: { type: 'script', id: randomUUID() }, ...base } as ResearchSuggestionItem; // FK violation
    await expect(withSystemDbAccessContext(() => persistResearchSuggestions({
      runId: s.runA, orgId: s.orgId, research: s.research,
      outcome: { summary: 's', items: [{ kind: 'manual_steps', steps: ['a'], ...base }, bad], rejected: [], noSafeFix: false },
    }))).rejects.toThrow();
    expect(await rowsFor(s.sourceId)).toHaveLength(0);
  });
});
