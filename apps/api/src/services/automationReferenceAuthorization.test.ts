import { describe, expect, it, vi } from 'vitest';
import {
  notificationChannels,
  scripts,
  softwareCatalog,
  softwareVersions,
} from '../db/schema';
import type { AutomationAction } from './automationRuntime';
import {
  AutomationReferenceAuthorizationError,
  resolveOwnedAutomationReferences,
  type AutomationReferenceOwner,
} from './automationReferenceAuthorization';

type ScriptRow = typeof scripts.$inferSelect;
type CatalogRow = typeof softwareCatalog.$inferSelect;
type VersionRow = typeof softwareVersions.$inferSelect;
type ChannelRow = typeof notificationChannels.$inferSelect;

const PARTNER_A = '11111111-1111-4111-8111-111111111111';
const PARTNER_B = '22222222-2222-4222-8222-222222222222';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const partnerOwner: AutomationReferenceOwner = {
  scope: 'partner',
  orgId: null,
  partnerId: PARTNER_A,
};
const orgOwnerA: AutomationReferenceOwner = {
  scope: 'organization',
  orgId: ORG_A,
  partnerId: PARTNER_A,
};

const baseScript: ScriptRow = {
  id: '30000000-0000-4000-8000-000000000000',
  orgId: ORG_A,
  partnerId: PARTNER_A,
  name: 'Collect diagnostics',
  description: 'Collects diagnostics',
  category: 'diagnostics',
  osTypes: ['windows'],
  language: 'powershell',
  content: 'Get-Date',
  parameters: null,
  timeoutSeconds: 300,
  runAs: 'system',
  isSystem: false,
  version: 1,
  exitCodeSeverityMapping: null,
  createdBy: null,
  createdAt: new Date('2026-08-24T00:00:00.000Z'),
  updatedAt: new Date('2026-08-24T00:00:00.000Z'),
  deletedAt: null,
};

const orgOwnedScriptA: ScriptRow = { ...baseScript };
const orgOwnedScriptB: ScriptRow = {
  ...baseScript,
  id: '30000000-0000-4000-8000-000000000001',
  orgId: ORG_B,
};
const partnerScript: ScriptRow = {
  ...baseScript,
  id: '30000000-0000-4000-8000-000000000002',
  orgId: null,
};
const systemScript: ScriptRow = {
  ...baseScript,
  id: '30000000-0000-4000-8000-000000000003',
  orgId: null,
  partnerId: null,
  isSystem: true,
};

const baseCatalog: CatalogRow = {
  id: '40000000-0000-4000-8000-000000000000',
  orgId: ORG_A,
  partnerId: null,
  integrationProvider: null,
  name: 'Managed package',
  vendor: 'Vendor',
  description: 'Managed package',
  category: 'utilities',
  iconUrl: null,
  websiteUrl: null,
  isManaged: true,
  createdAt: new Date('2026-08-24T00:00:00.000Z'),
};
const orgCatalogA: CatalogRow = { ...baseCatalog };
const orgCatalogB: CatalogRow = {
  ...baseCatalog,
  id: '40000000-0000-4000-8000-000000000001',
  orgId: ORG_B,
};
const partnerCatalog: CatalogRow = {
  ...baseCatalog,
  id: '40000000-0000-4000-8000-000000000002',
  orgId: null,
  partnerId: PARTNER_A,
  integrationProvider: 'huntress',
};

const baseVersion: VersionRow = {
  id: '50000000-0000-4000-8000-000000000000',
  catalogId: baseCatalog.id,
  version: '1.0.0',
  releaseDate: new Date('2026-08-24T00:00:00.000Z'),
  releaseNotes: null,
  downloadUrl: 'https://downloads.example.test/package',
  s3Key: null,
  fileType: 'msi',
  originalFileName: 'package.msi',
  checksum: 'a'.repeat(64),
  fileSize: 1024,
  supportedOs: ['windows'],
  architecture: 'x64',
  silentInstallArgs: '/quiet',
  silentUninstallArgs: null,
  preInstallScript: null,
  postInstallScript: null,
  detectionRules: null,
  isLatest: true,
};

const baseChannel: ChannelRow = {
  id: '60000000-0000-4000-8000-000000000000',
  orgId: ORG_A,
  partnerId: null,
  name: 'Operations webhook',
  type: 'webhook',
  config: { url: 'https://hooks.example.test/notify' },
  templates: {},
  enabled: true,
  lastTestedAt: null,
  lastTestStatus: null,
  lastTestError: null,
  throttleMaxPerWindow: null,
  throttleWindowSeconds: 3600,
  createdAt: new Date('2026-08-24T00:00:00.000Z'),
  updatedAt: new Date('2026-08-24T00:00:00.000Z'),
};
const orgChannelA: ChannelRow = { ...baseChannel };
const orgChannelB: ChannelRow = {
  ...baseChannel,
  id: '60000000-0000-4000-8000-000000000001',
  orgId: ORG_B,
};
const partnerChannel: ChannelRow = {
  ...baseChannel,
  id: '60000000-0000-4000-8000-000000000002',
  orgId: null,
  partnerId: PARTNER_A,
};

type Fixtures = {
  scripts?: ScriptRow[];
  catalogs?: CatalogRow[];
  versions?: VersionRow[];
  channels?: ChannelRow[];
};

function fakeTransaction(fixtures: Fixtures) {
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => {
      if (table === softwareVersions) {
        return {
          innerJoin: vi.fn(() => ({
            where: vi.fn(async () =>
              (fixtures.versions ?? []).map((version) => ({
                version,
                catalog: (fixtures.catalogs ?? []).find((row) => row.id === version.catalogId),
              })),
            ),
          })),
        };
      }

      const rows = table === scripts
        ? fixtures.scripts ?? []
        : table === softwareCatalog
          ? fixtures.catalogs ?? []
          : table === notificationChannels
            ? fixtures.channels ?? []
            : [];
      return { where: vi.fn(async () => rows) };
    }),
  }));

  return { tx: { select } as never, select };
}

async function resolveFixture(
  owner: AutomationReferenceOwner,
  fixtures: Fixtures,
  actions: AutomationAction[],
  notificationTargets: string[] = [],
) {
  const { tx } = fakeTransaction(fixtures);
  try {
    const resolved = await resolveOwnedAutomationReferences(
      tx,
      owner,
      owner.scope === 'organization' ? [owner.orgId] : [ORG_A, ORG_B],
      actions,
      notificationTargets,
    );
    return { ok: true as const, resolved };
  } catch (error) {
    return { ok: false as const, error };
  }
}

function versionFor(catalog: CatalogRow): VersionRow {
  return { ...baseVersion, id: catalog.id.replace(/^4/, '5'), catalogId: catalog.id };
}

describe('resolveOwnedAutomationReferences', () => {
  it.each([
    ['partner rejects org-owned script sharing its partnerId', partnerOwner, orgOwnedScriptA, false],
    ['org rejects foreign-org script', orgOwnerA, orgOwnedScriptB, false],
    ['org accepts same-org script', orgOwnerA, orgOwnedScriptA, true],
    ['partner accepts partner-owned script with null orgId', partnerOwner, partnerScript, true],
    ['org accepts explicitly shared same-partner script', orgOwnerA, partnerScript, true],
    ['organization owner accepts is_system script', orgOwnerA, systemScript, true],
    ['partner owner accepts is_system script', partnerOwner, systemScript, true],
  ])('%s', async (_name, owner, script, expected) => {
    const outcome = await resolveFixture(
      owner,
      { scripts: [script] },
      [{ type: 'run_script', scriptId: script.id }],
    );

    expect(outcome.ok).toBe(expected);
    if (outcome.ok) expect(outcome.resolved.scriptsById.get(script.id)).toBe(script);
  });

  it('rejects deleted and unknown scripts with the same metadata-free error', async () => {
    const deleted = { ...orgOwnedScriptA, deletedAt: new Date('2026-08-24T01:00:00.000Z') };
    const deletedOutcome = await resolveFixture(
      orgOwnerA,
      { scripts: [deleted] },
      [{ type: 'run_script', scriptId: deleted.id }],
    );
    const unknownId = '39999999-9999-4999-8999-999999999999';
    const unknownOutcome = await resolveFixture(
      orgOwnerA,
      { scripts: [] },
      [{ type: 'run_script', scriptId: unknownId }],
    );

    for (const outcome of [deletedOutcome, unknownOutcome]) {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.error).toBeInstanceOf(AutomationReferenceAuthorizationError);
      expect(outcome.error).toMatchObject({ code: 'unknown_or_unauthorized_reference' });
      expect((outcome.error as Error).message).toBe('Unknown or unauthorized automation reference');
      expect(JSON.stringify(outcome.error)).not.toContain(deleted.name);
      expect(JSON.stringify(outcome.error)).not.toContain(unknownId);
    }
  });

  it.each([
    ['partner rejects org-owned catalog', partnerOwner, orgCatalogA, false],
    ['org rejects foreign-org catalog', orgOwnerA, orgCatalogB, false],
    ['org accepts same-org catalog', orgOwnerA, orgCatalogA, true],
    ['partner accepts partner-owned catalog', partnerOwner, partnerCatalog, true],
    ['org accepts explicitly shared same-partner catalog', orgOwnerA, partnerCatalog, true],
  ])('%s and derives its selected version through that catalog', async (_name, owner, catalog, expected) => {
    const version = versionFor(catalog);
    const outcome = await resolveFixture(
      owner,
      { catalogs: [catalog], versions: [version] },
      [{ type: 'deploy_software', catalogId: catalog.id }],
    );

    expect(outcome.ok).toBe(expected);
    if (outcome.ok) {
      expect(outcome.resolved.softwareCatalogsById.get(catalog.id)).toBe(catalog);
      expect(outcome.resolved.softwareVersionsByCatalogId.get(catalog.id)).toBe(version);
    }
  });

  it('rejects an unknown catalog and a catalog without a selected latest version identically', async () => {
    const unknownId = '49999999-9999-4999-8999-999999999999';
    const unknown = await resolveFixture(
      orgOwnerA,
      {},
      [{ type: 'deploy_software', catalogId: unknownId }],
    );
    const missingVersion = await resolveFixture(
      orgOwnerA,
      { catalogs: [orgCatalogA], versions: [] },
      [{ type: 'deploy_software', catalogId: orgCatalogA.id }],
    );

    for (const outcome of [unknown, missingVersion]) {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.error).toMatchObject({ code: 'unknown_or_unauthorized_reference' });
      expect(JSON.stringify(outcome.error)).not.toContain(unknownId);
      expect(JSON.stringify(outcome.error)).not.toContain(orgCatalogA.name);
    }
  });

  it('rejects a latest software version when its catalog ownership is foreign', async () => {
    const version = versionFor(orgCatalogB);
    const outcome = await resolveFixture(
      orgOwnerA,
      { catalogs: [orgCatalogB], versions: [version] },
      [{ type: 'deploy_software', catalogId: orgCatalogB.id }],
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatchObject({ code: 'unknown_or_unauthorized_reference' });
      expect(JSON.stringify(outcome.error)).not.toContain(orgCatalogB.id);
    }
  });

  it.each([
    ['partner rejects org-owned channel', partnerOwner, orgChannelA, false],
    ['org rejects foreign-org channel', orgOwnerA, orgChannelB, false],
    ['org accepts same-org channel', orgOwnerA, orgChannelA, true],
    ['partner accepts partner-owned channel', partnerOwner, partnerChannel, true],
    ['org accepts same-partner shared channel', orgOwnerA, partnerChannel, true],
  ])('%s', async (_name, owner, channel, expected) => {
    const outcome = await resolveFixture(
      owner,
      { channels: [channel] },
      [{ type: 'send_notification', notificationChannelId: channel.id }],
    );

    expect(outcome.ok).toBe(expected);
    if (outcome.ok) expect(outcome.resolved.notificationChannelsById.get(channel.id)).toBe(channel);
  });

  it('rejects an unknown notification channel without exposing its identifier', async () => {
    const unknownId = '69999999-9999-4999-8999-999999999999';
    const outcome = await resolveFixture(
      orgOwnerA,
      { channels: [] },
      [{ type: 'send_notification', notificationChannelId: unknownId }],
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatchObject({ code: 'unknown_or_unauthorized_reference' });
      expect(JSON.stringify(outcome.error)).not.toContain(unknownId);
    }
  });

  it('resolves action and failure-target channels once and deduplicates their IDs', async () => {
    const { tx, select } = fakeTransaction({ channels: [orgChannelA] });
    const resolved = await resolveOwnedAutomationReferences(
      tx,
      orgOwnerA,
      [ORG_A],
      [{ type: 'send_notification', notificationChannelId: orgChannelA.id }],
      [orgChannelA.id],
    );

    expect(resolved.notificationChannelsById.get(orgChannelA.id)).toBe(orgChannelA);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed XOR-owned catalog and channel rows even if one owner axis matches', async () => {
    const malformedCatalog = { ...orgCatalogA, partnerId: PARTNER_B };
    const malformedChannel = { ...orgChannelA, partnerId: PARTNER_B };
    const catalogOutcome = await resolveFixture(
      orgOwnerA,
      { catalogs: [malformedCatalog], versions: [versionFor(malformedCatalog)] },
      [{ type: 'deploy_software', catalogId: malformedCatalog.id }],
    );
    const channelOutcome = await resolveFixture(
      orgOwnerA,
      { channels: [malformedChannel] },
      [{ type: 'send_notification', notificationChannelId: malformedChannel.id }],
    );

    expect(catalogOutcome.ok).toBe(false);
    expect(channelOutcome.ok).toBe(false);
  });

  it('returns empty maps without querying when no action references a resource', async () => {
    const { tx, select } = fakeTransaction({});
    const resolved = await resolveOwnedAutomationReferences(
      tx,
      orgOwnerA,
      [ORG_A],
      [{ type: 'create_alert', alertSeverity: 'info', alertMessage: 'Hello' }],
      [],
    );

    expect(resolved.scriptsById.size).toBe(0);
    expect(resolved.softwareCatalogsById.size).toBe(0);
    expect(resolved.softwareVersionsByCatalogId.size).toBe(0);
    expect(resolved.notificationChannelsById.size).toBe(0);
    expect(select).not.toHaveBeenCalled();
  });
});
