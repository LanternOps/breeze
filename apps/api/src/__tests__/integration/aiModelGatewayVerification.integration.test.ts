/**
 * W06 Task 12 (#7604): verifyConnectionOffering against real rows. The real
 * gateway, CONNECT proxy, key decryption, registry lock and superseded check
 * run; only the fidelity harness is replaced (its own suite covers the stages,
 * and gatewaySdk.e2e covers the real Agent SDK through the gateway).
 *
 * Pins: a verification record is the only thing that turns tools on for a
 * gateway offering; a failed run turns them off; a run whose connection changed
 * mid-flight (endpoint OR key) writes nothing; an older run never overwrites a
 * newer verdict; a disconnected connection is refused; a busy registry lock is
 * waited out; `enabled` is never touched.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import type { FidelityCheckResult, runFidelityCheck } from '../../services/llm/providerFidelityHarness';
import { loadOfferingCandidate } from '../../services/aiModels/candidateLoader';
import { closeModelGateway } from '../../services/aiModels/gateway';
import { endpointFingerprint, readVerification } from '../../services/aiModels/gatewayCapabilities';
import {
  createGatewayConnection,
  createManualOffering,
  deleteGatewayConnection,
  updateGatewayConnection,
} from '../../services/aiModels/gatewayConnections';
import { partnerRegistryLockKey } from '../../services/aiModels/registryWriteLock';
import { verifyConnectionOffering, type OfferingVerificationDeps } from '../../services/aiModels/offeringVerification';
import { listOfferingToolSurfaces } from '../../services/aiModels/offeringVerificationStore';
import { getLlmEgressProxy } from '../../services/llm/llmEgressProxy';
import { __setLookupForTests } from '../../services/urlSafety';
import { closeRegistryFixtures, fixtureSql, partnerContext } from './aiModelRegistryFixtures';
import { createPartner } from './db-utils';

afterAll(async () => {
  await closeModelGateway();
  await (await getLlmEgressProxy()).close();
  await closeRegistryFixtures();
});

const KEY = 'live-partner-key-0123456789abcdef';
const BASE = 'https://llm.example.com/v1';
const asPartner = <T>(partnerId: string, fn: () => Promise<T>) => withDbAccessContext(partnerContext(partnerId), fn);

const PASS: FidelityCheckResult = {
  passed: true,
  steps: [{ name: 'direct_tool_use', ok: true }, { name: 'direct_tool_result', ok: true }, { name: 'sdk_subprocess', ok: true }],
  probes: [{ name: 'direct_adaptive_effort', ok: false, detail: 'skipped: not applicable to this connection kind' }],
  verifiedCapabilities: { adaptiveEffort: false },
  harnessVersion: '1',
};
const FAIL: FidelityCheckResult = {
  ...PASS,
  passed: false,
  steps: [{ name: 'direct_tool_use', ok: false, detail: `no tool_use block; echoed ${KEY}` }],
};
const harness = (fn: () => Promise<FidelityCheckResult> | FidelityCheckResult) => ({
  runHarness: (async () => fn()) as unknown as typeof runFidelityCheck,
});

beforeEach(() => {
  __setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
});
afterEach(() => {
  __setLookupForTests(null);
});

async function seed(): Promise<{ partnerId: string; connectionId: string; offeringId: string }> {
  const partnerId = (await createPartner()).id;
  const conn = await asPartner(partnerId, () => createGatewayConnection({
    partnerId, name: `gw-${randomUUID().slice(0, 8)}`, baseUrl: BASE, apiKey: KEY, connectedBy: null,
  }));
  const offering = await asPartner(partnerId, () => createManualOffering({ partnerId, connectionId: conn.id, modelId: 'qwen2.5-coder:7b' }));
  return { partnerId, connectionId: conn.id, offeringId: offering.id };
}

async function offeringRow(offeringId: string): Promise<{ capabilities: unknown; enabled: boolean }> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.execute<{ capabilities: unknown; enabled: boolean }>(sql`
      SELECT capabilities, enabled FROM partner_ai_models WHERE id = ${offeringId}::uuid`);
    return row!;
  });
}

async function connectionVersion(connectionId: string): Promise<number> {
  const [row] = await fixtureSql<Array<{ config_version: number }>>`
    SELECT config_version FROM partner_ai_connections WHERE id = ${connectionId}`;
  return row!.config_version;
}

describe('verifyConnectionOffering (real DB)', () => {
  it('pass → verified record bound to the endpoint; the resolver now offers tools; enabled untouched', async () => {
    const { partnerId, offeringId } = await seed();
    const before = await loadOfferingCandidate(offeringId, partnerId);
    expect(before!.facts.supportsTools).toBe(false);

    const r = await verifyConnectionOffering({ offeringId, partnerId }, harness(() => PASS));
    expect(r.state).toBe('verified');
    const row = await offeringRow(offeringId);
    expect(row.enabled).toBe(false);
    expect(readVerification(row.capabilities)).toMatchObject({
      passed: true, toolUse: true, adaptiveEffort: false, summary: null,
      endpointFingerprint: endpointFingerprint({ kind: 'openai_compatible', baseUrl: BASE, providerConfig: null }),
    });
    const after = await loadOfferingCandidate(offeringId, partnerId);
    expect(after!.facts.supportsTools).toBe(true);
    expect(after!.capabilities).toMatchObject({ supportsTools: true, thinkingMode: 'none' });
  });

  it('fail → failed record (scrubbed), tools off — also when it replaces an earlier pass', async () => {
    const { partnerId, offeringId } = await seed();
    await verifyConnectionOffering({ offeringId, partnerId }, harness(() => PASS));
    expect((await loadOfferingCandidate(offeringId, partnerId))!.facts.supportsTools).toBe(true);

    const r = await verifyConnectionOffering({ offeringId, partnerId }, harness(() => FAIL));
    expect(r.state).toBe('failed');
    const row = await offeringRow(offeringId);
    expect(JSON.stringify(row.capabilities)).not.toContain(KEY);
    expect(readVerification(row.capabilities)).toMatchObject({ passed: false, toolUse: false });
    expect((await loadOfferingCandidate(offeringId, partnerId))!.facts.supportsTools).toBe(false);
  });

  it('a base-URL change unverifies by fingerprint; a key rotation does not', async () => {
    const { partnerId, connectionId, offeringId } = await seed();
    await verifyConnectionOffering({ offeringId, partnerId }, harness(() => PASS));
    await asPartner(partnerId, async () => updateGatewayConnection({
      partnerId, connectionId, apiKey: 'rotated-key-abcdef0123456789', expectedConfigVersion: await connectionVersion(connectionId),
    }));
    expect((await loadOfferingCandidate(offeringId, partnerId))!.facts.supportsTools).toBe(true);
    await asPartner(partnerId, async () => updateGatewayConnection({
      partnerId, connectionId, baseUrl: 'https://other-llm.example.com/v1', apiKey: 'other-llm-key-0123456789', expectedConfigVersion: await connectionVersion(connectionId),
    }));
    expect((await loadOfferingCandidate(offeringId, partnerId))!.facts.supportsTools).toBe(false);
  });

  it('endpoint changed while verifying → superseded, nothing written for the new endpoint', async () => {
    const { partnerId, connectionId, offeringId } = await seed();
    const r = await verifyConnectionOffering({ offeringId, partnerId }, harness(async () => {
      await asPartner(partnerId, async () => updateGatewayConnection({
        partnerId, connectionId, baseUrl: 'https://other-llm.example.com/v1', apiKey: 'other-llm-key-0123456789', expectedConfigVersion: await connectionVersion(connectionId),
      }));
      return PASS;
    }));
    expect(r.state).toBe('superseded');
    expect(r.connectionChanged).toBe(true);
    expect((await offeringRow(offeringId)).capabilities).toBeNull();
    expect((await loadOfferingCandidate(offeringId, partnerId))!.facts.supportsTools).toBe(false);
  });

  it('key rotated while verifying → superseded (a run on the old key never overwrites the verdict)', async () => {
    const { partnerId, connectionId, offeringId } = await seed();
    await verifyConnectionOffering({ offeringId, partnerId }, harness(() => PASS));
    const verified = (await offeringRow(offeringId)).capabilities;
    const r = await verifyConnectionOffering({ offeringId, partnerId }, harness(async () => {
      await asPartner(partnerId, async () => updateGatewayConnection({
        partnerId, connectionId, apiKey: 'rotated-key-abcdef0123456789', expectedConfigVersion: await connectionVersion(connectionId),
      }));
      return FAIL;
    }));
    expect(r.state).toBe('superseded');
    expect((await offeringRow(offeringId)).capabilities).toEqual(verified);
  });

  it('an older run never overwrites a verdict that finished after it started', async () => {
    const { partnerId, offeringId } = await seed();
    const outer = await verifyConnectionOffering({ offeringId, partnerId }, harness(async () => {
      const inner = await verifyConnectionOffering({ offeringId, partnerId }, harness(() => PASS));
      expect(inner.state).toBe('verified');
      return FAIL;
    }));
    expect(outer.state).toBe('superseded');
    expect(outer.connectionChanged).toBe(false);
    expect(readVerification((await offeringRow(offeringId)).capabilities)).toMatchObject({ passed: true });
  });

  it('disconnected (before, or during the run) → refused / superseded; never written', async () => {
    const { partnerId, connectionId, offeringId } = await seed();
    await asPartner(partnerId, () => deleteGatewayConnection({ partnerId, connectionId }));
    let ran = false;
    await expect(verifyConnectionOffering({ offeringId, partnerId }, harness(() => { ran = true; return PASS; })))
      .rejects.toMatchObject({ status: 409, details: { reason: 'connection_unavailable' } });
    expect(ran).toBe(false);
    expect((await offeringRow(offeringId)).capabilities).toBeNull();

    const live = await seed();
    const r = await verifyConnectionOffering({ offeringId: live.offeringId, partnerId: live.partnerId }, harness(async () => {
      await asPartner(live.partnerId, () => deleteGatewayConnection({ partnerId: live.partnerId, connectionId: live.connectionId }));
      return PASS;
    }));
    expect(r.state).toBe('superseded');
    expect(r.connectionChanged).toBe(false);
    expect((await offeringRow(live.offeringId)).capabilities).toBeNull();
  });

  it('refuses another partner\'s offering', async () => {
    const { offeringId } = await seed();
    const other = (await createPartner()).id;
    await expect(verifyConnectionOffering({ offeringId, partnerId: other }, harness(() => PASS)))
      .rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect((await offeringRow(offeringId)).capabilities).toBeNull();
  });

  it('waits out a busy partner registry lock instead of failing the job', async () => {
    const { partnerId, offeringId } = await seed();
    let release!: () => void;
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const holder = fixtureSql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${partnerRegistryLockKey(partnerId)}, 0))`;
      locked();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await lockTaken;
    setTimeout(() => release(), 800);
    const r = await verifyConnectionOffering({ offeringId, partnerId }, harness(() => PASS));
    await holder;
    expect(r.state).toBe('verified');
    expect(readVerification((await offeringRow(offeringId)).capabilities)).toMatchObject({ passed: true });
  });
});

describe('verifyConnectionOffering surface turns (#11397, real DB)', () => {
  type Runner = NonNullable<OfferingVerificationDeps['surfaceTurn']>;
  const plan = (surface: string) => ({
    kind: 'planned' as const,
    plan: {
      surface: surface as never, profile: 'full' as const, fingerprint: 'full', compactSchemas: false, systemPrompt: 'p',
      mcpServerName: 'breeze', tools: [], allowedTools: [], targetTool: 'query_devices', validate: () => ({ success: true as const }),
    },
  });
  const turn = (outcome: 'passed' | 'failed' | 'inconclusive', onRun?: () => Promise<void>): Runner => ({
    plan: async (surface) => plan(surface),
    run: async () => {
      await onRun?.();
      return {
        outcome, passed: outcome === 'passed', detail: outcome === 'passed' ? 'ok' : `answered without calling a tool (${KEY})`,
        promptTokens: 1200, cachedTokens: 0, calledTool: null, zodValid: outcome === 'passed', sentinelSeen: outcome === 'passed',
      };
    },
  });
  const assign = async (offeringPartnerId: string, surface: string, cols: { def?: string; permitted?: string[] | null; fallback?: string[] | null }) => {
    await fixtureSql`
      INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, role, default_offering_id, permitted_offering_ids, fallback_offering_ids)
      VALUES (${offeringPartnerId}, ${offeringPartnerId}, ${surface}, 'default', ${cols.def ?? null},
        ${cols.permitted === undefined || cols.permitted === null ? null : fixtureSql.array(cols.permitted, 2950)},
        ${cols.fallback === undefined || cols.fallback === null ? null : fixtureSql.array(cols.fallback, 2950)})`;
  };
  const readiness = async (offeringId: string) =>
    ((await offeringRow(offeringId)).capabilities as Record<string, Record<string, Record<string, unknown>>> | null)?.breeze_surface_readiness ?? {};

  it('lists only surfaces that name the offering (default, permitted, fallback), tool surfaces only, chat first', async () => {
    const { partnerId, offeringId } = await seed();
    await assign(partnerId, 'script_builder', { fallback: [offeringId] });
    await assign(partnerId, 'helper', { permitted: [offeringId] });
    await assign(partnerId, 'chat', { def: offeringId });
    await assign(partnerId, 'ai_agents', { permitted: null }); // permits every model: does not name it
    await assign(partnerId, 'catalog_enrichment', { def: offeringId }); // not a tool surface
    expect(await withSystemDbAccessContext(() => listOfferingToolSurfaces(partnerId, offeringId))).toEqual(['chat', 'helper', 'script_builder']);
    const other = (await createPartner()).id;
    expect(await withSystemDbAccessContext(() => listOfferingToolSurfaces(other, offeringId))).toEqual([]);
  });

  it('writes the readiness beside the basic record; a failed chat turn refuses chat only at the resolver', async () => {
    const { partnerId, offeringId } = await seed();
    await assign(partnerId, 'chat', { def: offeringId });
    await assign(partnerId, 'helper', { permitted: [offeringId] });
    const runner: Runner = {
      plan: async (surface) => plan(surface),
      run: async (input) => (input.plan.surface === 'chat' ? turn('failed') : turn('passed')).run(input),
    };
    const r = await verifyConnectionOffering({ offeringId, partnerId }, { ...harness(() => PASS), surfaceTurn: runner });
    expect(r.state).toBe('verified');
    const stored = await readiness(offeringId);
    expect(Object.keys(stored).sort()).toEqual(['chat', 'helper']);
    expect(stored.chat).toMatchObject({ state: 'failed', profileKey: 'full', version: '1', promptTokens: 1200 });
    expect(JSON.stringify(stored)).not.toContain(KEY);
    expect(readVerification((await offeringRow(offeringId)).capabilities)).toMatchObject({ passed: true });
    const c = await loadOfferingCandidate(offeringId, partnerId);
    expect(c!.facts.supportsTools).toBe(true);
    expect(c!.facts.failedToolSurfaces).toEqual(['chat']);
  });

  it('a later run keeps the surfaces it did not run, re-runs a refused surface after its assignment moved, and a profile change un-refuses', async () => {
    const { partnerId, offeringId } = await seed();
    await assign(partnerId, 'chat', { def: offeringId });
    await assign(partnerId, 'script_builder', { def: offeringId });
    await verifyConnectionOffering({ offeringId, partnerId }, { ...harness(() => PASS), surfaceTurn: turn('passed') });
    // Chat now fails; the script builder entry stays as it was.
    await fixtureSql`DELETE FROM ai_model_assignments WHERE offering_partner_id = ${partnerId} AND surface = 'script_builder'`;
    await verifyConnectionOffering({ offeringId, partnerId }, { ...harness(() => PASS), surfaceTurn: turn('failed') });
    expect(await readiness(offeringId)).toMatchObject({ chat: { state: 'failed' }, script_builder: { state: 'passed' } });
    // The chat assignment moves away; a re-verify still re-runs chat (refused now) beside the helper.
    await fixtureSql`DELETE FROM ai_model_assignments WHERE offering_partner_id = ${partnerId}`;
    await assign(partnerId, 'helper', { def: offeringId });
    const ran: string[] = [];
    await verifyConnectionOffering({ offeringId, partnerId }, {
      ...harness(() => PASS),
      surfaceTurn: { plan: async (surface) => { ran.push(surface); return plan(surface); }, run: async (input) => turn(input.plan.surface === 'chat' ? 'failed' : 'passed').run(input) },
    });
    expect(ran).toEqual(['chat', 'helper']);
    expect(Object.keys(await readiness(offeringId)).sort()).toEqual(['chat', 'helper', 'script_builder']);
    expect((await loadOfferingCandidate(offeringId, partnerId))!.facts.failedToolSurfaces).toEqual(['chat']);

    await fixtureSql`UPDATE partner_ai_models SET tool_profile = 'standard' WHERE id = ${offeringId}`;
    expect((await loadOfferingCandidate(offeringId, partnerId))!.facts.failedToolSurfaces).toEqual([]);
  });

  it('a tool-profile change while the turn runs: that entry is superseded (not written); the basic record still is', async () => {
    const { partnerId, offeringId } = await seed();
    await assign(partnerId, 'chat', { def: offeringId });
    const r = await verifyConnectionOffering({ offeringId, partnerId }, {
      ...harness(() => PASS),
      surfaceTurn: turn('failed', async () => { await fixtureSql`UPDATE partner_ai_models SET tool_profile = 'minimal' WHERE id = ${offeringId}`; }),
    });
    expect(r.state).toBe('verified');
    expect(await readiness(offeringId)).toEqual({});
    expect(readVerification((await offeringRow(offeringId)).capabilities)).toMatchObject({ passed: true });
  });

  it('a failed basic run runs no surface turn and keeps the stored readiness', async () => {
    const { partnerId, offeringId } = await seed();
    await assign(partnerId, 'chat', { def: offeringId });
    await verifyConnectionOffering({ offeringId, partnerId }, { ...harness(() => PASS), surfaceTurn: turn('passed') });
    let ran = 0;
    await verifyConnectionOffering({ offeringId, partnerId }, { ...harness(() => FAIL), surfaceTurn: turn('failed', async () => { ran += 1; }) });
    expect(ran).toBe(0);
    expect((await readiness(offeringId)).chat).toMatchObject({ state: 'passed' });
    expect((await loadOfferingCandidate(offeringId, partnerId))!.facts.supportsTools).toBe(false);
  });
});
