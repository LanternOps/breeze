/**
 * Integration test — W08 (#6778) topology write tools honour the org axis, the
 * site axis and the partner-wide gate, against real Postgres as the
 * unprivileged `breeze_app` role.
 *
 * Tools: manage_topology_manual, manage_topology_monitoring (policies, targets,
 * settings) and manage_topology_templates (partner-wide and org rows).
 *
 * Entry point: `executeTool`, so the same dispatch as production runs. The
 * human approval step (publish is supervised) lives in the chat layer and is
 * pinned in aiGuardrails.approvalScope.contract.test.ts; this suite proves the
 * scope behaviour that runs after it.
 *
 * Proven against stored rows (not just the tool's reply):
 *   - a site-restricted caller cannot write to a site outside its allowlist; the row is NOT created / changed;
 *   - another organization's caller sees "not found" for the site and nothing is written;
 *   - an org caller cannot create or read partner-wide templates, nor act on a partner-wide row;
 *   - a partner-axis caller with full org access can;
 *   - a site-ceilinged caller cannot create an org-wide template (canMutateOrgWideGovernance).
 * Each refusal has a CONTROL: lifting the guard (the unrestricted caller, same
 * input) lands the write, so the refusal is the gate and not a broken fixture.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { withDbAccessContext } from '../../db';
import { topologyConfigTemplates, topologyConfigTemplateVersions, topologyManualNodes, topologyProbeTargets } from '../../db/schema';
import { executeTool } from '../../services/aiTools';
import { clearPermissionCache } from '../../services/permissions';
import { getTestDb } from './setup';
import { contextFor, seedTopologyOpsFixture, type TopologyOpsFixture, type Who } from './topology-ai-ops-fixtures';

let f: TopologyOpsFixture;
beforeEach(async () => {
  clearPermissionCache();
  f = await seedTopologyOpsFixture();
});

async function run(who: Who, tool: string, input: Record<string, unknown>) {
  const raw = await withDbAccessContext(contextFor(f, who), () => executeTool(tool, input, f.auth[who]));
  return JSON.parse(raw) as Record<string, any>;
}

const manualNodes = (siteId: string) => getTestDb().select().from(topologyManualNodes).where(eq(topologyManualNodes.siteId, siteId));
const targets = (siteId: string) => getTestDb().select().from(topologyProbeTargets).where(eq(topologyProbeTargets.siteId, siteId));
const orgTemplates = (orgId: string) => getTestDb().select().from(topologyConfigTemplates).where(eq(topologyConfigTemplates.orgId, orgId));
const partnerTemplates = (partnerId: string) => getTestDb().select().from(topologyConfigTemplates).where(eq(topologyConfigTemplates.partnerId, partnerId));

const TARGET = {
  kind: 'tcp', label: 'App', host: 'service.example.test', port: 443, enabled: true, families: ['ipv4'], provider: null, independenceLabel: null,
};

describe('manage_topology_manual — site and org axes', () => {
  it('a restricted caller writes in its own site and is refused in another, with no row created', async () => {
    const inSite = await run('restricted', 'manage_topology_manual', { action: 'create_node', siteId: f.siteA1, label: 'Core', role: 'switch' });
    expect(inSite.id, JSON.stringify(inSite)).toBeTruthy();
    expect(await manualNodes(f.siteA1)).toHaveLength(1);

    const outOfSite = await run('restricted', 'manage_topology_manual', { action: 'create_node', siteId: f.siteA2, label: 'Edge', role: 'switch' });
    expect(outOfSite).toMatchObject({ code: 'topology_site_not_found' });
    expect(await manualNodes(f.siteA2)).toHaveLength(0);
  });

  it('CONTROL: with the site ceiling lifted, the same call lands in the other site', async () => {
    const lifted = await run('orgAll', 'manage_topology_manual', { action: 'create_node', siteId: f.siteA2, label: 'Edge', role: 'switch' });
    expect(lifted.id, JSON.stringify(lifted)).toBeTruthy();
    expect(await manualNodes(f.siteA2)).toHaveLength(1);
  });

  it("another organization's caller cannot reach the site and nothing is written", async () => {
    const cross = await run('otherOrg', 'manage_topology_manual', { action: 'create_node', siteId: f.siteA1, label: 'X', role: 'router' });
    expect(cross.code).toMatch(/topology_site_not_found|topology_permission_denied/);
    expect(await manualNodes(f.siteA1)).toHaveLength(0);
  });

  it('a delete of a node in an out-of-site site is refused and the node survives', async () => {
    const created = await run('orgAll', 'manage_topology_manual', { action: 'create_node', siteId: f.siteA2, label: 'Edge', role: 'switch' });
    const refused = await run('restricted', 'manage_topology_manual', { action: 'delete_node', siteId: f.siteA2, nodeId: created.id, expectedRevision: created.revision });
    expect(refused).toMatchObject({ code: 'topology_site_not_found' });
    expect(await manualNodes(f.siteA2)).toHaveLength(1);
  });
});

describe('manage_topology_monitoring — targets and settings across site and org boundaries', () => {
  async function revision(who: Who, siteId: string): Promise<string> {
    const settings = await run(who, 'manage_topology_monitoring', { action: 'get_settings', siteId });
    return String(settings.settingsRevision);
  }

  it('a restricted caller cannot read, write or patch another site; nothing changes', async () => {
    const rev = await revision('orgAll', f.siteA2);
    expect(await run('restricted', 'manage_topology_monitoring', { action: 'get_settings', siteId: f.siteA2 })).toMatchObject({ code: 'topology_site_not_found' });
    expect(await run('restricted', 'manage_topology_monitoring', { action: 'upsert_target', siteId: f.siteA2, key: 'app', definition: TARGET, expectedRevision: rev }))
      .toMatchObject({ code: 'topology_site_not_found' });
    expect(await run('restricted', 'manage_topology_monitoring', { action: 'patch_settings', siteId: f.siteA2, overrides: { outboundEnabled: false }, expectedRevision: rev }))
      .toMatchObject({ code: 'topology_site_not_found' });
    expect(await targets(f.siteA2)).toHaveLength(0);
    expect(await revision('orgAll', f.siteA2)).toBe(rev);
  });

  it('CONTROL: with the site ceiling lifted, the same target write lands and bumps the revision', async () => {
    const rev = await revision('orgAll', f.siteA2);
    const written = await run('orgAll', 'manage_topology_monitoring', { action: 'upsert_target', siteId: f.siteA2, key: 'app', definition: TARGET, expectedRevision: rev });
    expect(written.key, JSON.stringify(written)).toBe('app');
    expect(await targets(f.siteA2)).toHaveLength(1);
    expect(await revision('orgAll', f.siteA2)).not.toBe(rev);
  });

  it('a stale expectedRevision is a revision conflict and writes nothing', async () => {
    const rev = await revision('orgAll', f.siteA1);
    await run('orgAll', 'manage_topology_monitoring', { action: 'upsert_target', siteId: f.siteA1, key: 'app', definition: TARGET, expectedRevision: rev });
    const stale = await run('orgAll', 'manage_topology_monitoring', { action: 'upsert_target', siteId: f.siteA1, key: 'other', definition: TARGET, expectedRevision: rev });
    expect(stale.code).toMatch(/revision_conflict|settings_revision/);
    expect(await targets(f.siteA1)).toHaveLength(1);
  });

  it("another organization's caller is refused", async () => {
    const cross = await run('otherOrg', 'manage_topology_monitoring', { action: 'list_policies', siteId: f.siteA1 });
    expect(cross.code).toMatch(/topology_site_not_found|topology_permission_denied/);
  });
});

describe('manage_topology_templates — the partner-wide gate', () => {
  it('an org caller cannot create or list partner-wide templates; a full-access partner admin can', async () => {
    const denied = await run('orgAll', 'manage_topology_templates', { action: 'create_template', ownerScope: 'partner', key: 'shared', name: 'Shared' });
    expect(denied.code).toBe('topology_permission_denied');
    expect(await partnerTemplates(f.partnerId)).toHaveLength(0);

    const created = await run('partnerAdmin', 'manage_topology_templates', { action: 'create_template', ownerScope: 'partner', key: 'shared', name: 'Shared' });
    expect(created.id, JSON.stringify(created)).toBeTruthy();
    expect(await partnerTemplates(f.partnerId)).toHaveLength(1);

    const listDenied = await run('orgAll', 'manage_topology_templates', { action: 'list_templates', ownerScope: 'partner' });
    expect(listDenied.code).toBe('topology_permission_denied');
    const listed = await run('partnerAdmin', 'manage_topology_templates', { action: 'list_templates', ownerScope: 'partner' });
    expect(listed.items).toHaveLength(1);
  });

  it('an org caller cannot read versions of, version, publish or revoke a partner-wide template', async () => {
    const t = await run('partnerAdmin', 'manage_topology_templates', { action: 'create_template', ownerScope: 'partner', key: 'shared', name: 'Shared' });
    const v = await run('partnerAdmin', 'manage_topology_templates', { action: 'create_version', templateId: t.id, expectedRevision: t.revision, payload: { targets: {}, policies: {} } });
    expect(v.id, JSON.stringify(v)).toBeTruthy();

    const [before] = await partnerTemplates(f.partnerId);
    const rev = before!.revision.toString();
    for (const input of [
      { action: 'list_versions', templateId: t.id },
      { action: 'create_version', templateId: t.id, expectedRevision: rev, payload: { targets: {}, policies: {} } },
      { action: 'publish_version', templateId: t.id, versionId: v.id, expectedTemplateRevision: rev, expectedVersionRevision: v.revision },
      { action: 'revoke_template', templateId: t.id, expectedRevision: rev },
    ]) {
      const out = await run('orgAll', 'manage_topology_templates', input);
      expect(out.code, `${input.action}: ${JSON.stringify(out)}`).toMatch(/topology_permission_denied|topology_template_not_found/);
    }
    const [after] = await partnerTemplates(f.partnerId);
    expect(after!.lifecycle).toBe('active');
    expect(after!.revision.toString()).toBe(rev);
    expect(await getTestDb().select().from(topologyConfigTemplateVersions).where(eq(topologyConfigTemplateVersions.templateId, t.id))).toHaveLength(1);

    // CONTROL: the partner admin, same revisions, can publish; so the refusals above are the gate.
    const published = await run('partnerAdmin', 'manage_topology_templates', {
      action: 'publish_version', templateId: t.id, versionId: v.id, expectedTemplateRevision: rev, expectedVersionRevision: v.revision,
    });
    expect(published.state, JSON.stringify(published)).toBe('published');
  });

  it('a site-ceilinged caller cannot create an org-wide template; the unrestricted org caller can', async () => {
    const refused = await run('restricted', 'manage_topology_templates', { action: 'create_template', ownerScope: 'organization', key: 'local', name: 'Local' });
    expect(refused.code).toBe('topology_template_not_found');
    expect(await orgTemplates(f.orgA)).toHaveLength(0);

    const control = await run('orgAll', 'manage_topology_templates', { action: 'create_template', ownerScope: 'organization', key: 'local', name: 'Local' });
    expect(control.id, JSON.stringify(control)).toBeTruthy();
    expect(await orgTemplates(f.orgA)).toHaveLength(1);
  });

  it("another organization's caller cannot see an org's template", async () => {
    const t = await run('orgAll', 'manage_topology_templates', { action: 'create_template', ownerScope: 'organization', key: 'local', name: 'Local' });
    const cross = await run('otherOrg', 'manage_topology_templates', { action: 'list_versions', templateId: t.id });
    expect(cross.code, JSON.stringify(cross)).toMatch(/topology_template_not_found|topology_permission_denied/);
    expect(await getTestDb().select().from(topologyConfigTemplates).where(and(eq(topologyConfigTemplates.orgId, f.orgA), eq(topologyConfigTemplates.key, 'local')))).toHaveLength(1);
  });

  it('site_options for a site outside the allowlist is refused', async () => {
    expect(await run('restricted', 'manage_topology_templates', { action: 'site_options', siteId: f.siteA2 })).toMatchObject({ code: 'topology_site_not_found' });
    const control = await run('orgAll', 'manage_topology_templates', { action: 'site_options', siteId: f.siteA2 });
    expect(Array.isArray(control.items), JSON.stringify(control)).toBe(true);
  });
});
