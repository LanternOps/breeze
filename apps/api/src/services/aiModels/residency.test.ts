import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  candidates: new Map<string, unknown>(),
  carries: { agent_sdk: false, messages_api: false } as Record<string, boolean>,
  partnerUpdates: [] as Array<Record<string, unknown>>,
  orgRows: [] as Array<{ orgId: string; orgName: string | null; surface: string; defaultOfferingId: string }>,
  lockedPartners: [] as string[],
}));

vi.mock('./assignmentRows', () => ({ listAssignmentRows: vi.fn(async () => h.rows) }));
vi.mock('./candidateLoader', () => ({
  loadOfferingCandidate: vi.fn(async (id: string) => h.candidates.get(id) ?? null),
  loadPartnerFacts: vi.fn(async () => ({ plan: 'pro', residencyRequired: false })),
}));
vi.mock('./transport', () => ({
  defaultTransport: (s: string) => (['chat', 'helper', 'script_builder', 'ai_agents', 'office_chat'].includes(s) ? 'agent_sdk' : 'messages_api'),
  transportCarries: (t: string) => ({ speed: false, thinkingDisplayUpdates: false, inferenceGeo: h.carries[t] }),
}));
// Every W04 registry write runs behind the partner registry lock (ruling).
vi.mock('./offeringWrites', () => ({
  inPartnerRegistryWrite: vi.fn(async (partnerId: string, _label: string, _msg: string, fn: () => Promise<unknown>) => {
    h.lockedPartners.push(partnerId);
    return fn();
  }),
}));
vi.mock('../../config/env', () => ({ isHosted: () => true }));
vi.mock('../../db', () => ({
  db: {
    update: () => ({ set: (s: Record<string, unknown>) => ({ where: async () => { h.partnerUpdates.push(s); } }) }),
    // org-override rows for the preview (select … leftJoin … where)
    select: () => ({ from: () => ({ leftJoin: () => ({ where: async () => h.orgRows }) }) }),
  },
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { previewResidencyImpact, setResidencyRequired } from './residency';

const renderSettingsSet = (s: Record<string, unknown>) => new PgDialect().sqlToQuery(s.settings as SQL);

const P = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RATES = { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 };
const cand = (geo: string | null, supported: string[]) => ({
  facts: {
    ownerPartnerId: P, enabled: true, lifecycle: 'available', requiredPermission: null,
    platform: { platformOffered: true, lifecycle: 'available', minPlan: null },
    connection: { kind: 'platform', status: 'active', keyUsable: true }, catalog: null,
    rate: { source: 'platform', standard: RATES }, supportsTools: true, inferenceGeo: geo, supportedInferenceGeos: supported,
  },
});

beforeEach(() => {
  h.rows = []; h.orgRows = []; h.candidates.clear(); h.partnerUpdates = []; h.lockedPartners = [];
  h.carries = { agent_sdk: false, messages_api: false };
});

describe('previewResidencyImpact', () => {
  it('lists every surface whose partner default would be residency_unavailable', async () => {
    h.rows = [
      { surface: 'chat', role: 'default', orgId: null, defaultOfferingId: A },
      { surface: 'catalog_enrichment', role: 'default', orgId: null, defaultOfferingId: B },
    ];
    h.candidates.set(A, cand(null, []));
    h.candidates.set(B, cand('eu', ['eu']));
    h.carries = { agent_sdk: false, messages_api: true };
    expect((await previewResidencyImpact(P)).unavailableSurfaces).toEqual(['chat']);
  });

  it('lists org overrides whose own default would fail, even when the partner default is fine', async () => {
    h.carries = { agent_sdk: true, messages_api: true };
    h.rows = [{ surface: 'chat', role: 'default', orgId: null, defaultOfferingId: B }];
    h.candidates.set(B, cand('eu', ['eu']));
    h.candidates.set(A, cand(null, []));
    h.orgRows = [{ orgId: 'o1', orgName: 'Acme', surface: 'chat', defaultOfferingId: A }];
    expect(await previewResidencyImpact(P)).toEqual({ unavailableSurfaces: [], affectedOrgOverrides: [{ orgId: 'o1', orgName: 'Acme', surface: 'chat' }] });
  });

  it('treats a geo-capable default as unavailable while its transport cannot carry inference_geo (W01 spike pending)', async () => {
    h.rows = [{ surface: 'catalog_enrichment', role: 'default', orgId: null, defaultOfferingId: B }];
    h.candidates.set(B, cand('eu', ['eu']));
    expect((await previewResidencyImpact(P)).unavailableSurfaces).toEqual(['catalog_enrichment']);
  });

  it('counts a role row (ai_agents triage) that would fail, listing the surface once', async () => {
    h.carries = { agent_sdk: true, messages_api: true };
    h.rows = [
      { surface: 'ai_agents', role: 'default', orgId: null, defaultOfferingId: B },
      { surface: 'ai_agents', role: 'triage', orgId: null, defaultOfferingId: A },
      { surface: 'ai_agents', role: 'analysis', orgId: null, defaultOfferingId: A },
    ];
    h.candidates.set(A, cand(null, []));
    h.candidates.set(B, cand('eu', ['eu']));
    expect((await previewResidencyImpact(P)).unavailableSurfaces).toEqual(['ai_agents']);
  });

  // W03 soft-disconnect: an offering on a disconnected connection is already
  // unusable (disabled + connection_unavailable). It is not residency's impact
  // — never a working candidate — and never lists a surface a second time.
  describe('an offering on a disconnected connection', () => {
    const onDisconnected = (enabled: boolean) => {
      const c = cand(null, []);
      return { facts: { ...c.facts, enabled, platform: null, connection: { kind: 'anthropic_byok', status: 'disconnected', keyUsable: false } } };
    };

    it.each([
      ['disabled, as disconnectCompat leaves it', false],
      ['still enabled (defence in depth)', true],
    ])('is not counted as a default residency would break (%s)', async (_l, enabled) => {
      h.carries = { agent_sdk: true, messages_api: true };
      h.rows = [{ surface: 'helper', role: 'default', orgId: null, defaultOfferingId: A }];
      h.orgRows = [{ orgId: 'o1', orgName: 'Acme', surface: 'chat', defaultOfferingId: A }];
      h.candidates.set(A, onDisconnected(enabled));
      expect(await previewResidencyImpact(P)).toEqual({ unavailableSurfaces: [], affectedOrgOverrides: [] });
    });

    it('beside a live default that residency would break, the surface is listed once', async () => {
      h.rows = [
        { surface: 'ai_agents', role: 'default', orgId: null, defaultOfferingId: B },
        { surface: 'ai_agents', role: 'triage', orgId: null, defaultOfferingId: A },
      ];
      h.candidates.set(A, onDisconnected(false));
      h.candidates.set(B, cand(null, []));
      h.orgRows = [
        { orgId: 'o1', orgName: 'Acme', surface: 'ai_agents', defaultOfferingId: A },
        { orgId: 'o1', orgName: 'Acme', surface: 'ai_agents', defaultOfferingId: B },
      ];
      expect(await previewResidencyImpact(P)).toEqual({
        unavailableSurfaces: ['ai_agents'],
        affectedOrgOverrides: [{ orgId: 'o1', orgName: 'Acme', surface: 'ai_agents' }],
      });
    });
  });

  it('ignores rows without a default and offerings the partner no longer owns', async () => {
    h.rows = [
      { surface: 'chat', role: 'default', orgId: null, defaultOfferingId: null },
      { surface: 'helper', role: 'default', orgId: null, defaultOfferingId: A },
    ];
    expect(await previewResidencyImpact(P)).toEqual({ unavailableSurfaces: [], affectedOrgOverrides: [] });
  });
});

describe('setResidencyRequired', () => {
  it('refuses to turn residency on with impact unless acknowledged, and writes nothing', async () => {
    h.rows = [{ surface: 'chat', role: 'default', orgId: null, defaultOfferingId: A }];
    h.candidates.set(A, cand(null, []));
    const err = await setResidencyRequired({ partnerId: P, required: true, acknowledgeImpact: false }).catch((e) => e);
    expect([err.status, err.code, err.details.unavailableSurfaces]).toEqual([409, 'not_eligible', ['chat']]);
    expect(h.partnerUpdates).toHaveLength(0);
  });

  it('refuses when only an org override would break', async () => {
    h.carries = { agent_sdk: true, messages_api: true };
    h.orgRows = [{ orgId: 'o1', orgName: 'Acme', surface: 'chat', defaultOfferingId: A }];
    h.candidates.set(A, cand(null, []));
    const err = await setResidencyRequired({ partnerId: P, required: true, acknowledgeImpact: false }).catch((e) => e);
    expect([err.status, err.code, err.details.affectedOrgOverrides]).toEqual([409, 'not_eligible', [{ orgId: 'o1', orgName: 'Acme', surface: 'chat' }]]);
    expect(h.partnerUpdates).toHaveLength(0);
  });

  it('writes when acknowledged, under the partner registry lock, merging only settings.ai.residencyRequired', async () => {
    h.rows = [{ surface: 'chat', role: 'default', orgId: null, defaultOfferingId: A }];
    h.candidates.set(A, cand(null, []));
    const r = await setResidencyRequired({ partnerId: P, required: true, acknowledgeImpact: true });
    expect(r.residencyRequired).toBe(true);
    expect(r.impact.unavailableSurfaces).toEqual(['chat']);
    expect(h.partnerUpdates).toHaveLength(1);
    const q = renderSettingsSet(h.partnerUpdates[0]!);
    expect(q.sql).toContain(`jsonb_build_object('ai', COALESCE("partners"."settings" -> 'ai', '{}'::jsonb)`);
    expect(q.sql).toContain(`jsonb_build_object('residencyRequired', $1::boolean)`);
    expect(q.params).toEqual([true]);
    expect(h.lockedPartners).toEqual([P]);
  });

  it('writes without acknowledgement when nothing would break', async () => {
    h.carries = { agent_sdk: true, messages_api: true };
    h.rows = [{ surface: 'chat', role: 'default', orgId: null, defaultOfferingId: B }];
    h.candidates.set(B, cand('eu', ['eu']));
    await expect(setResidencyRequired({ partnerId: P, required: true, acknowledgeImpact: false }))
      .resolves.toMatchObject({ residencyRequired: true, impact: { unavailableSurfaces: [], affectedOrgOverrides: [] } });
    expect(h.partnerUpdates).toHaveLength(1);
  });

  it('turning residency off never needs acknowledgement', async () => {
    h.rows = [{ surface: 'chat', role: 'default', orgId: null, defaultOfferingId: A }];
    h.candidates.set(A, cand(null, []));
    await expect(setResidencyRequired({ partnerId: P, required: false, acknowledgeImpact: false })).resolves.toMatchObject({ residencyRequired: false });
    expect(h.partnerUpdates).toHaveLength(1);
    expect(renderSettingsSet(h.partnerUpdates[0]!).params).toEqual([false]);
  });
});
