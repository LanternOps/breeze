/**
 * The tool profile / context window override write (#11398 W05) against real
 * Postgres. The unit suites mock the DB, so only this proves:
 *  - `loadServedToolSurfaces`' SQL finds a model through a partner default, an
 *    org override's permitted list, a failover list and an agent pin, and
 *    never through another partner's rows;
 *  - the floor check refuses before anything is written (the row is unchanged);
 *  - an accepted write lands the columns the DB CHECKs accept, and switching
 *    custom → standard clears the allow-list in the same statement;
 *  - another partner's id never writes.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { withDbAccessContext, withSystemDbAccessContext, runOutsideDbContext } from '../../db';
import { updateOfferingDetails } from '../../services/aiModels/offeringWrites';
import { breezeToolProfileCatalog } from '../../services/aiModels/toolProfileCatalog';
import { loadServedToolSurfaces } from '../../services/aiModels/toolSettingsWrite';
import { createOrganization, createPartner, createUser } from './db-utils';
import { closeRegistryFixtures, fixtureSql, partnerContext, seedOffering } from './aiModelRegistryFixtures';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

const asPartner = <T>(p: string, fn: () => Promise<T>) => withDbAccessContext(partnerContext(p), fn);
const inSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const caught = (p: Promise<unknown>) => p.then(
  () => { throw new Error('expected a rejection'); },
  (e: unknown) => e as { status?: number; code?: string; details?: Record<string, unknown> },
);

async function seedGatewayOffering(partnerId: string, configVersion = 2) {
  const [conn] = await fixtureSql`
    INSERT INTO partner_ai_connections (partner_id, kind, name, base_url, config_version)
    VALUES (${partnerId}, 'openai_compatible', 'Local endpoint', 'https://llm.example.com/v1', ${configVersion})
    RETURNING id`;
  const connectionId = String(conn!.id);
  const offeringId = await seedOffering({ partnerId, connectionId, modelId: `qwen-${randomUUID().slice(0, 8)}`, source: 'discovered', enabled: false });
  return { connectionId, offeringId };
}

async function toolColumns(id: string) {
  const [row] = await fixtureSql`
    SELECT tool_profile, tool_allowlist, context_window_override, updated_at FROM partner_ai_models WHERE id = ${id}`;
  return row!;
}
const version = async (id: string) => new Date((await toolColumns(id)).updated_at as Date).toISOString();

async function seedPartnerDefault(partnerId: string, surface: string, offeringId: string, role = 'default') {
  await fixtureSql`
    INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, role, default_offering_id, allow_user_choice)
    VALUES (${partnerId}, ${partnerId}, ${surface}, ${role}, ${offeringId}, true)`;
}

describe.skipIf(!RUN)('tool settings write (#11398)', () => {
  it('loadServedToolSurfaces finds partner defaults, org permitted lists, failover lists and agent pins; never another partner', async () => {
    const p = (await createPartner()).id;
    const other = (await createPartner()).id;
    const org = (await createOrganization({ partnerId: p })).id;
    const { offeringId } = await seedGatewayOffering(p);
    const { offeringId: otherOffering } = await seedGatewayOffering(other);
    await seedPartnerDefault(p, 'script_builder', offeringId);
    await fixtureSql`
      INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, role, permitted_offering_ids)
      VALUES (${org}, ${p}, 'helper', 'default', ${[offeringId]})`;
    await fixtureSql`
      INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, role, fallback_offering_ids)
      VALUES (${p}, ${p}, 'chat', 'default', ${[offeringId]})`;
    // Another partner's row naming its own offering never counts for ours.
    await seedPartnerDefault(other, 'office_chat', otherOffering);

    const served = await inSystem(() => loadServedToolSurfaces(p, offeringId));
    expect([...served.surfaces].sort()).toEqual(['chat', 'helper', 'script_builder']);
    expect(served.troubleshootingRuns).toBe(false);

    const user = await createUser({ partnerId: p });
    await fixtureSql`
      INSERT INTO ai_agents (partner_id, kind, name, created_by, offering_id, offering_partner_id)
      VALUES (${p}, 'troubleshoot', 'Pinned', ${user.id}, ${offeringId}, ${p})`;
    const withAgent = await inSystem(() => loadServedToolSurfaces(p, offeringId));
    expect(withAgent.surfaces.has('ai_agents')).toBe(true);
    expect(withAgent.troubleshootingRuns).toBe(true);

    // Control: the other partner's offering is served only by its own row.
    const otherServed = await inSystem(() => loadServedToolSurfaces(other, otherOffering));
    expect([...otherServed.surfaces]).toEqual(['office_chat']);
  });

  it('an ai_agents analysis-role default makes troubleshooting runs reach the model; a triage role does not', async () => {
    const p = (await createPartner()).id;
    const { offeringId } = await seedGatewayOffering(p);
    await seedPartnerDefault(p, 'ai_agents', offeringId, 'triage');
    expect((await inSystem(() => loadServedToolSurfaces(p, offeringId))).troubleshootingRuns).toBe(false);
    await seedPartnerDefault(p, 'ai_agents', offeringId, 'analysis');
    expect((await inSystem(() => loadServedToolSurfaces(p, offeringId))).troubleshootingRuns).toBe(true);
  });

  it('minimal on the script builder default is refused and the row is unchanged; standard lands', async () => {
    const p = (await createPartner()).id;
    const { offeringId } = await seedGatewayOffering(p);
    await seedPartnerDefault(p, 'script_builder', offeringId);
    const toolCatalog = breezeToolProfileCatalog();

    const before = await version(offeringId);
    const err = await caught(asPartner(p, () => updateOfferingDetails({
      partnerId: p, offeringId, toolCatalog, patch: { expectedUpdatedAt: before, toolProfile: 'minimal' },
    })));
    expect([err.status, err.code]).toEqual([422, 'tool_profile_underpowered']);
    expect(err.details).toEqual({ field: 'toolProfile', surfaces: [{ surface: 'script_builder', missing: ['execute_script_on_device'] }] });
    expect(await toolColumns(offeringId)).toMatchObject({ tool_profile: 'auto', tool_allowlist: null });
    expect(await version(offeringId)).toBe(before);

    const result = await asPartner(p, () => updateOfferingDetails({
      partnerId: p, offeringId, toolCatalog, patch: { expectedUpdatedAt: before, toolProfile: 'standard', contextWindowOverride: 32_768 },
    }));
    expect(result.toolSettingsChange).toEqual({
      from: { toolProfile: 'auto', toolAllowlist: null, contextWindowOverride: null },
      to: { toolProfile: 'standard', toolAllowlist: null, contextWindowOverride: 32_768 },
    });
    expect(await toolColumns(offeringId)).toMatchObject({ tool_profile: 'standard', tool_allowlist: null, context_window_override: 32_768 });
  });

  it('custom lands with its list; custom → standard clears the list in the same write (the DB CHECK holds)', async () => {
    const p = (await createPartner()).id;
    const { offeringId } = await seedGatewayOffering(p);
    const toolCatalog = breezeToolProfileCatalog();
    await asPartner(p, async () => updateOfferingDetails({
      partnerId: p, offeringId, toolCatalog,
      patch: { expectedUpdatedAt: await version(offeringId), toolProfile: 'custom', toolAllowlist: { domains: ['devices'], tools: ['search_logs'] } },
    }));
    expect(await toolColumns(offeringId)).toMatchObject({ tool_profile: 'custom', tool_allowlist: { domains: ['devices'], tools: ['search_logs'] } });

    // The list alone cannot be dropped while the profile stays custom.
    const lone = await caught(asPartner(p, async () => updateOfferingDetails({
      partnerId: p, offeringId, toolCatalog, patch: { expectedUpdatedAt: await version(offeringId), toolProfile: 'standard' },
    })));
    expect([lone.status, lone.details]).toEqual([422, { field: 'toolAllowlist', reason: 'allowlist_requires_custom' }]);

    await asPartner(p, async () => updateOfferingDetails({
      partnerId: p, offeringId, toolCatalog, patch: { expectedUpdatedAt: await version(offeringId), toolProfile: 'standard', toolAllowlist: null },
    }));
    expect(await toolColumns(offeringId)).toMatchObject({ tool_profile: 'standard', tool_allowlist: null });
  });

  it("partner A cannot write partner B's model (404, row untouched)", async () => {
    const a = (await createPartner()).id;
    const b = (await createPartner()).id;
    const { offeringId } = await seedGatewayOffering(b);
    const err = await caught(asPartner(a, async () => updateOfferingDetails({
      partnerId: a, offeringId, toolCatalog: breezeToolProfileCatalog(),
      patch: { expectedUpdatedAt: await version(offeringId), toolProfile: 'minimal' },
    })));
    expect([err.status, err.code]).toEqual([404, 'not_found']);
    expect(await toolColumns(offeringId)).toMatchObject({ tool_profile: 'auto' });
  });
});
