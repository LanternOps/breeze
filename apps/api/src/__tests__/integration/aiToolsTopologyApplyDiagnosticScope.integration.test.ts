/**
 * Integration test — W08 (#6778) run_topology_diagnostic and apply_topology_template
 * honour the site, device and org axes, against real Postgres as the unprivileged
 * `breeze_app` role.
 *
 * Entry point: `executeTool`, so the CENTRAL device gate (`deviceArgs:
 * ['originDeviceId']`) runs before the handler exactly as in production. The
 * supervised classes (publish, revoke, apply) are asserted through
 * `checkGuardrails`, the same function the chat layer asks before it raises an
 * intent; the approval itself is unit-tested in aiGuardrails.* and the release
 * path in actionIntents/actorContext.test.ts.
 *
 * Proven against stored rows:
 *   - a diagnostic start naming a device in a site outside the caller's allowlist is refused by the
 *     central gate and no run row exists; with the ceiling lifted the same call gets past the gate (CONTROL);
 *   - a template preview naming an out-of-allowlist site is refused for the WHOLE request and persists
 *     nothing, even when an in-allowlist site is named alongside; the unrestricted caller's preview of the
 *     same site persists one preview record (CONTROL);
 *   - a preview token is bound to its requester: another user's apply is refused and no application exists;
 *   - another organization's caller cannot read an application's status;
 *   - publish / revoke / apply raise a supervised approval, preview does not.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { devices, topologyChangeOutbox, topologyDiagnosticRuns } from '../../db/schema';
import { checkGuardrails } from '../../services/aiGuardrails';
import { executeTool } from '../../services/aiTools';
import { clearPermissionCache } from '../../services/permissions';
import { PREVIEW_EVENT } from '../../services/topology/templateApplicationTypes';
import { getTestDb } from './setup';
import { contextFor, seedTopologyOpsFixture, type TopologyOpsFixture, type Who } from './topology-ai-ops-fixtures';

let f: TopologyOpsFixture;
let versionId: string;
beforeEach(async () => {
  clearPermissionCache();
  f = await seedTopologyOpsFixture();
  // One published org-owned template version for org A (system seed, like topologyTemplateTenancy).
  const templateId = randomUUID();
  versionId = randomUUID();
  await withSystemDbAccessContext(async () => {
    await db.execute(sql`INSERT INTO topology_config_templates(id, org_id, key, name) VALUES(${templateId}::uuid, ${f.orgA}::uuid, 'std', 'Standard')`);
    await db.execute(sql`INSERT INTO topology_config_template_versions(id, template_id, org_id, version, state, payload, content_digest, published_at)
      VALUES(${versionId}::uuid, ${templateId}::uuid, ${f.orgA}::uuid, 1, 'published', '{"targets":{},"policies":{}}', ${'0'.repeat(64)}, now())`);
  });
});

async function run(who: Who, tool: string, input: Record<string, unknown>) {
  const raw = await withDbAccessContext(contextFor(f, who), () => executeTool(tool, input, f.auth[who]));
  return JSON.parse(raw) as Record<string, any>;
}

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  const [row] = await getTestDb().insert(devices).values({
    orgId, siteId, agentId: `topo-${randomUUID()}`, hostname: `topo-${randomUUID().slice(0, 8)}`,
    osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '1.0.0', status: 'online',
  }).returning({ id: devices.id });
  return row!.id;
}

const runs = (siteId: string) => getTestDb().select().from(topologyDiagnosticRuns).where(eq(topologyDiagnosticRuns.siteId, siteId));
const previews = async (orgId: string) =>
  (await getTestDb().select().from(topologyChangeOutbox).where(eq(topologyChangeOutbox.orgId, orgId))).filter((row) => row.eventKind === PREVIEW_EVENT);

const DEVICE_DENIED = 'Device not found or access denied';
const startInput = (siteId: string, originDeviceId: string) => ({
  action: 'start', siteId, recipeId: 'gateway_basic', subjectKind: 'node', subjectId: randomUUID(), graphRevision: '0', originDeviceId,
});

describe('run_topology_diagnostic — device and site axes', () => {
  it('start from a device in a site outside the allowlist is refused by the central gate; no run row exists', async () => {
    const outOfSiteDevice = await seedDevice(f.orgA, f.siteA2);
    const refused = await run('restricted', 'run_topology_diagnostic', startInput(f.siteA1, outOfSiteDevice));
    expect(JSON.stringify(refused)).toContain(DEVICE_DENIED);
    expect(await runs(f.siteA1)).toHaveLength(0);
    expect(await runs(f.siteA2)).toHaveLength(0);
  });

  it('CONTROL: with the ceiling lifted the same call is no longer refused by the device gate', async () => {
    const device = await seedDevice(f.orgA, f.siteA2);
    const lifted = await run('orgAll', 'run_topology_diagnostic', startInput(f.siteA1, device));
    expect(JSON.stringify(lifted)).not.toContain(DEVICE_DENIED);
    // It reaches the service, which answers about the (unknown) subject / origin, not about scope.
    expect(typeof (lifted.error ?? lifted.runId)).toBe('string');
  });

  it('a start, a collectors read and a cancel against a site outside the allowlist are one indistinguishable refusal', async () => {
    const inSiteDevice = await seedDevice(f.orgA, f.siteA1);
    for (const input of [
      startInput(f.siteA2, inSiteDevice),
      { action: 'collectors', siteId: f.siteA2, recipeId: 'gateway_basic', subjectKind: 'node', subjectId: randomUUID(), graphRevision: '0' },
      { action: 'cancel', siteId: f.siteA2, runId: randomUUID() },
      { action: 'get', siteId: f.siteA2, runId: randomUUID() },
    ]) {
      expect(await run('restricted', 'run_topology_diagnostic', input)).toMatchObject({ code: 'topology_site_not_found' });
    }
    expect(await runs(f.siteA2)).toHaveLength(0);
  });

  it("another organization's caller cannot start in, or read from, this org's site", async () => {
    const device = await seedDevice(f.orgA, f.siteA1);
    const start = await run('otherOrg', 'run_topology_diagnostic', startInput(f.siteA1, device));
    expect(JSON.stringify(start)).toMatch(/Device not found|topology_site_not_found|topology_permission_denied/);
    expect(await runs(f.siteA1)).toHaveLength(0);
  });
});

describe('apply_topology_template — site axis, requester binding and org axis', () => {
  const sitesInput = (...siteIds: string[]) => siteIds.map((siteId) => ({ siteId, expectedBindingRevision: '0' }));

  it('a preview naming an out-of-allowlist site is refused as a whole and persists nothing', async () => {
    const only = await run('restricted', 'apply_topology_template', { action: 'preview', orgVersionId: versionId, sites: sitesInput(f.siteA2) });
    expect(only).toMatchObject({ code: 'topology_site_not_found' });
    const mixed = await run('restricted', 'apply_topology_template', { action: 'preview', orgVersionId: versionId, sites: sitesInput(f.siteA1, f.siteA2) });
    expect(mixed).toMatchObject({ code: 'topology_site_not_found' });
    expect(await previews(f.orgA)).toHaveLength(0);
  });

  it('CONTROL: the unrestricted caller previews the same out-of-allowlist site and a preview record persists', async () => {
    const out = await run('orgAll', 'apply_topology_template', { action: 'preview', orgVersionId: versionId, sites: sitesInput(f.siteA2) });
    expect(out.token, JSON.stringify(out)).toBeTruthy();
    expect(await previews(f.orgA)).toHaveLength(1);
  });

  it('a restricted caller previews its own site', async () => {
    const out = await run('restricted', 'apply_topology_template', { action: 'preview', orgVersionId: versionId, sites: sitesInput(f.siteA1) });
    expect(out.token, JSON.stringify(out)).toBeTruthy();
    expect(out.sites[0]).toMatchObject({ siteId: f.siteA1 });
  });

  it("a preview token is bound to its requester: another organization's apply of it is refused and no application exists", async () => {
    const preview = await run('orgAll', 'apply_topology_template', { action: 'preview', orgVersionId: versionId, sites: sitesInput(f.siteA1) });
    expect(preview.token, JSON.stringify(preview)).toBeTruthy();
    const stolen = await run('otherOrg', 'apply_topology_template', { action: 'apply', token: preview.token });
    expect(stolen.error, JSON.stringify(stolen)).toBeTruthy();
    expect(stolen.state).toBeUndefined();
    const rows = (await getTestDb().select().from(topologyChangeOutbox).where(eq(topologyChangeOutbox.orgId, f.orgA))).filter((r) => r.eventKind !== PREVIEW_EVENT && /template\.application/.test(r.eventKind));
    expect(rows).toHaveLength(0);
  });

  it("another organization's caller cannot read an application's status", async () => {
    const preview = await run('orgAll', 'apply_topology_template', { action: 'preview', orgVersionId: versionId, sites: sitesInput(f.siteA1) });
    const applied = await run('orgAll', 'apply_topology_template', { action: 'apply', token: preview.token });
    expect(applied.id, JSON.stringify(applied)).toEqual(expect.any(String));
    const own = await run('orgAll', 'apply_topology_template', { action: 'status', operationId: applied.id });
    expect(own.id, JSON.stringify(own)).toBe(applied.id);
    const cross = await run('otherOrg', 'apply_topology_template', { action: 'status', operationId: applied.id });
    expect(cross.state, JSON.stringify(cross)).toBeUndefined();
    expect(cross.error).toBeTruthy();
  });
});

describe('supervised classes raise an approval', () => {
  it.each([
    ['manage_topology_templates', { action: 'publish_version' }],
    ['manage_topology_templates', { action: 'revoke_template' }],
    ['apply_topology_template', { action: 'apply' }],
  ])('%s %j requires supervised approval', (tool, input) => {
    expect(checkGuardrails(tool, input)).toMatchObject({ tier: 3, requiresApproval: true, approvalScope: 'supervised' });
  });

  it.each([
    ['apply_topology_template', { action: 'preview' }],
    ['run_topology_diagnostic', { action: 'start' }],
    ['manage_topology_manual', { action: 'delete_node' }],
    ['manage_topology_monitoring', { action: 'patch_settings' }],
    ['manage_topology_templates', { action: 'create_version' }],
  ])('%s %j is tier 2, not supervised', (tool, input) => {
    expect(checkGuardrails(tool, input)).toMatchObject({ tier: 2 });
    expect(checkGuardrails(tool, input).approvalScope).toBeUndefined();
  });
});
