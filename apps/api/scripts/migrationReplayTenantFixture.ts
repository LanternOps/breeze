/**
 * Multi-tenant fixture for CI's full migration replay (`check:migrations`,
 * #5361).
 *
 * WHY. v0.111.0 took US down (#5357/#5239) with a migration whose two
 * set-based UPDATEs on `discovered_assets` fired the partner-export lock
 * triggers twice in one transaction: the second statement asked for a NEW
 * partner lock after org locks were already held and the lock-hierarchy guard
 * raised P0001. Every CI job passed, because a migration replay against an
 * EMPTY database hands those statement-level triggers empty transition tables
 * — the lock helpers get zero orgs and the guard can never fire.
 *
 * WHAT. Hooked into `autoMigrate({ afterMigration })`. After each migration,
 * every public table that now carries a partner-export material trigger
 * (`breeze_partner_export_{device_child,site_child,material}_{insert,update,
 * delete}`) and has not been seeded yet receives one row per org across
 * 2 partners x 2 orgs. From then on, every later migration's set-based DML on
 * those tables crosses partner and org boundaries the way it does in
 * production. Rows are seeded on the first migration where the trigger
 * exists, so each template is written against the schema AT THAT POINT in
 * history (2026-07-20 for the shipped set) — adding a NOT-NULL-without-default
 * column to one of these tables later fails here, as it would in production.
 *
 * ORDER. Tenants are inserted in an order that is NOT ascending by UUID (orgs
 * descending, partners interleaved and descending), so nothing downstream can
 * pass by accident because the fixture happened to arrive pre-sorted.
 *
 * FAIL LOUD. A trigger table without a template aborts the replay: coverage
 * must not silently lapse when the trigger set grows. Conversely,
 * `check:migrations` fails when a template table was never seeded (hook not
 * firing, trigger renamed, scan query drifted).
 *
 * SCOPE. The device/site material family only (#5360's lock family: partners
 * shared, then orgs exclusive). The configuration family (#5912:
 * `breeze_partner_export_{configuration_owner,direct_org,policy_child,
 * assignment,...}_*`) has a different lock order and is not seeded here. Add a template to
 * FIXTURE_TABLE_TEMPLATES, written against the schema of the migration that
 * installs the trigger.
 *
 * Each statement runs in its own transaction with `breeze.scope = system`
 * elected first (FORCE RLS binds the table owner; migrations may run as a
 * non-superuser). One statement per transaction also keeps the fixture's own
 * inserts from tripping the lock hierarchy it exists to exercise.
 */
import { randomUUID } from 'node:crypto';

import type postgres from 'postgres';

export interface FixtureTenant {
  n: number;
  partnerId: string;
  orgId: string;
  siteId: string;
  deviceId: string;
  assetId: string;
}

/**
 * Returns the table's own multi-row INSERT first, then any follow-on
 * statements that make the rows heterogeneous (each runs in its own
 * transaction, in order).
 */
type Template = (tenants: readonly FixtureTenant[]) => string[];

const q = (value: string) => `'${value.replace(/'/g, "''")}'`;

function values(tenants: readonly FixtureTenant[], row: (t: FixtureTenant) => string[]): string {
  return tenants.map((t) => `(${row(t).join(', ')})`).join(',\n  ');
}

function insert(table: string, columns: string[], tenants: readonly FixtureTenant[], row: (t: FixtureTenant) => string[]): string {
  return `INSERT INTO public.${table} (${columns.join(', ')}) VALUES\n  ${values(tenants, row)}`;
}

const deviceChild = (table: string, extra: Record<string, (t: FixtureTenant) => string> = {}): Template =>
  (tenants) => [insert(table, ['org_id', 'device_id', ...Object.keys(extra)], tenants, (t) => [
    `${q(t.orgId)}::uuid`,
    `${q(t.deviceId)}::uuid`,
    ...Object.values(extra).map((f) => f(t)),
  ])];

const siteChildInsert = (
  table: string,
  extra: Record<string, (t: FixtureTenant) => string>,
  tenants: readonly FixtureTenant[],
) => insert(table, ['org_id', 'site_id', ...Object.keys(extra)], tenants, (t) => [
  `${q(t.orgId)}::uuid`,
  `${q(t.siteId)}::uuid`,
  ...Object.values(extra).map((f) => f(t)),
]);

const siteChild = (table: string, extra: Record<string, (t: FixtureTenant) => string>): Template =>
  (tenants) => [siteChildInsert(table, extra, tenants)];

/**
 * HETEROGENEITY. Identical rows in every org make every WHERE clause select
 * all orgs or none, so no statement ever locks a strict subset of partners —
 * and the hierarchy guard only fires when a LATER statement in the same
 * transaction needs a partner an earlier one did not lock. A uniform fixture
 * replays 2026-10-14-100100 green even with its pre-lock (100050) removed
 * (verified by hand on PR #7012; this fixture makes that control fail P0001).
 *
 * So tenant 0 alone runs a UniFi-managed switch, the shape of the US outage
 * data: its asset carries `detected_asset_type` and is linked from
 * `unifi_devices` (through an integration + site mapping on tenant 0's
 * partner). 2026-08-20 then backfills `detected_type_source` for that row
 * only, and 100100's `source = 'unifi'` statement locks tenant 0's partner
 * alone before the `source = 'scan'` statement needs the other partner.
 */
function discoveredAssets(tenants: readonly FixtureTenant[]): string[] {
  const managed = tenants[0]!;
  const integrationId = randomUUID();
  const mappingId = randomUUID();
  return [
    siteChildInsert('discovered_assets', {
      id: (t) => `${q(t.assetId)}::uuid`,
      ip_address: (t) => `${q(`198.51.100.${10 + t.n}`)}::inet`,
      asset_type: () => q('switch'),
      approval_status: () => q('approved'),
      detected_asset_type: (t) => (t === managed ? q('switch') : 'NULL'),
    }, tenants),
    insert('unifi_integrations', ['id', 'partner_id', 'connection_type'], [managed], () => [
      `${q(integrationId)}::uuid`,
      `${q(managed.partnerId)}::uuid`,
      q('self_hosted'),
    ]),
    insert(
      'unifi_site_mappings',
      ['id', 'integration_id', 'org_id', 'site_id', 'unifi_host_id', 'unifi_site_id'],
      [managed],
      (t) => [
        `${q(mappingId)}::uuid`,
        `${q(integrationId)}::uuid`,
        `${q(t.orgId)}::uuid`,
        `${q(t.siteId)}::uuid`,
        q('mrf-host'),
        q('mrf-site'),
      ],
    ),
    insert(
      'unifi_devices',
      ['org_id', 'site_id', 'integration_id', 'mapping_id', 'discovered_asset_id', 'unifi_device_id', 'raw'],
      [managed],
      (t) => [
        `${q(t.orgId)}::uuid`,
        `${q(t.siteId)}::uuid`,
        `${q(integrationId)}::uuid`,
        `${q(mappingId)}::uuid`,
        `${q(t.assetId)}::uuid`,
        q('mrf-unifi-switch'),
        `${q('{}')}::jsonb`,
      ],
    ),
  ];
}

/**
 * One INSERT per trigger table, one row per org. Columns are the NOT NULL
 * columns without defaults as of 2026-07-20 (the migration that installs the
 * triggers), plus whatever makes the row one the partner export publishes —
 * `discovered_assets` rows are approved switches, because since
 * 2026-10-28-100000 the site-child update trigger locks only for published
 * rows, and pending ones would hide lock-order bugs. See `discoveredAssets`
 * for why one tenant's row differs from the others.
 */
export const FIXTURE_TABLE_TEMPLATES: Readonly<Record<string, Template>> = {
  device_hardware: deviceChild('device_hardware'),
  device_disks: deviceChild('device_disks', {
    mount_point: () => q('/'),
    total_gb: () => '100',
    used_gb: () => '40',
    free_gb: () => '60',
    used_percent: () => '40',
  }),
  device_network: deviceChild('device_network', {
    interface_name: () => q('eth0'),
  }),
  device_ip_history: deviceChild('device_ip_history', {
    interface_name: () => q('eth0'),
    ip_address: (t) => q(`192.0.2.${10 + t.n}`),
  }),
  software_inventory: deviceChild('software_inventory', {
    name: () => q('migration-replay-fixture-app'),
  }),
  device_warranty: deviceChild('device_warranty'),
  hyperv_vms: deviceChild('hyperv_vms', {
    vm_id: (t) => q(`mrf-vm-${t.n}`),
    vm_name: (t) => q(`fixture-vm-${t.n}`),
  }),
  discovered_assets: discoveredAssets,
  network_baselines: siteChild('network_baselines', {
    subnet: (t) => q(`198.51.${100 + t.n}.0/24`),
  }),
  network_topology: siteChild('network_topology', {
    source_type: () => q('device'),
    source_id: (t) => `${q(t.deviceId)}::uuid`,
    target_type: () => q('discovered_asset'),
    target_id: (t) => `${q(t.assetId)}::uuid`,
    connection_type: () => q('lldp'),
  }),
};

/**
 * 2 partners x 2 orgs, one site and one device per org. Array order is the
 * insertion order: orgs strictly DESCENDING by UUID, partners interleaved
 * (hi, lo, hi, lo) with the higher partner UUID first.
 */
export function buildFixtureTenants(): FixtureTenant[] {
  const desc = (ids: string[]) => ids.sort((a, b) => b.localeCompare(a));
  const [partnerHi, partnerLo] = desc([randomUUID(), randomUUID()]) as [string, string];
  const orgs = desc([randomUUID(), randomUUID(), randomUUID(), randomUUID()]);
  return orgs.map((orgId, n) => ({
    n,
    partnerId: n % 2 === 0 ? partnerHi : partnerLo,
    orgId,
    siteId: randomUUID(),
    deviceId: randomUUID(),
    assetId: randomUUID(),
  }));
}

function tenantStatements(tenants: readonly FixtureTenant[]): string[] {
  const partners = tenants.filter((t, i) => tenants.findIndex((u) => u.partnerId === t.partnerId) === i);
  return [
    insert('partners', ['id', 'name', 'slug'], partners, (t) => [
      `${q(t.partnerId)}::uuid`,
      q(`Migration Replay Fixture Partner ${t.n}`),
      q(`mrf-partner-${t.partnerId}`),
    ]),
    insert('organizations', ['id', 'partner_id', 'name', 'slug'], tenants, (t) => [
      `${q(t.orgId)}::uuid`,
      `${q(t.partnerId)}::uuid`,
      q(`Migration Replay Fixture Org ${t.n}`),
      q(`mrf-org-${t.orgId}`),
    ]),
    insert('sites', ['id', 'org_id', 'name'], tenants, (t) => [
      `${q(t.siteId)}::uuid`,
      `${q(t.orgId)}::uuid`,
      q(`Migration Replay Fixture Site ${t.n}`),
    ]),
    insert(
      'devices',
      ['id', 'org_id', 'site_id', 'agent_id', 'hostname', 'os_type', 'os_version', 'architecture', 'agent_version'],
      tenants,
      (t) => [
        `${q(t.deviceId)}::uuid`,
        `${q(t.orgId)}::uuid`,
        `${q(t.siteId)}::uuid`,
        q(`mrf-agent-${t.deviceId}`),
        q(`fixture-host-${t.n}`),
        q('linux'),
        q('fixture'),
        q('x86_64'),
        q('0.0.0'),
      ],
    ),
  ];
}

export interface FixturePorts {
  /** Public tables currently carrying a partner-export material trigger. */
  listTriggerTables: () => Promise<string[]>;
  /** Run one DML statement in its own system-scoped transaction. */
  execute: (statement: string) => Promise<void>;
}

export function createMigrationReplayTenantFixture(ports: FixturePorts, tenants = buildFixtureTenants()) {
  const seeded = new Set<string>();
  let tenantsCreated = false;

  return {
    tenants,
    seededTables: () => [...seeded].sort(),
    /** Template tables never seeded; the caller fails the replay if any remain. */
    unseededTemplateTables: () => Object.keys(FIXTURE_TABLE_TEMPLATES).filter((t) => !seeded.has(t)).sort(),
    async afterMigration(filename: string): Promise<void> {
      // Declaration order of FIXTURE_TABLE_TEMPLATES, never alphabetical, so a
      // template may rely on rows an earlier-declared template inserted.
      // Tables with no template sort last; they fail below anyway.
      const declared = Object.keys(FIXTURE_TABLE_TEMPLATES);
      const rank = (table: string) => (declared.includes(table) ? declared.indexOf(table) : declared.length);
      const pending = (await ports.listTriggerTables())
        .filter((table) => !seeded.has(table))
        .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      if (pending.length === 0) return;

      const missing = pending.filter((table) => !FIXTURE_TABLE_TEMPLATES[table]);
      if (missing.length > 0) {
        throw new Error(
          `[migration-replay-fixture] after ${filename}: ${missing.join(', ')} now carries a ` +
            'partner-export material trigger but has no fixture template. Add one to ' +
            'FIXTURE_TABLE_TEMPLATES in apps/api/scripts/migrationReplayTenantFixture.ts, ' +
            'written against the schema as of this migration (#5361).',
        );
      }

      if (!tenantsCreated) {
        for (const statement of tenantStatements(tenants)) await ports.execute(statement);
        tenantsCreated = true;
      }
      for (const table of pending) {
        try {
          for (const statement of FIXTURE_TABLE_TEMPLATES[table]!(tenants)) await ports.execute(statement);
        } catch (error) {
          throw new Error(
            `[migration-replay-fixture] seeding ${table} after ${filename} failed: ${(error as Error).message}`,
            { cause: error },
          );
        }
        seeded.add(table);
      }
      console.log(`[migration-replay-fixture] after ${filename}: seeded 2 partners x 2 orgs into ${pending.join(', ')}`);
    },
  };
}

const TRIGGER_TABLES_SQL = `
  SELECT DISTINCT c.relname AS table_name
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE n.nspname = 'public'
     AND NOT t.tgisinternal
     AND p.proname ~ '^breeze_partner_export_(device_child|site_child|material)_(insert|update|delete)$'
   ORDER BY 1`;

/** Bind the fixture to autoMigrate's pinned migration connection. */
export function migrationReplayTenantFixtureFor(client: postgres.Sql) {
  return createMigrationReplayTenantFixture({
    listTriggerTables: async () =>
      (await client.unsafe<{ table_name: string }[]>(TRIGGER_TABLES_SQL)).map((row) => row.table_name),
    execute: async (statement) => {
      await client.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('breeze.scope', 'system', true)`);
        await tx.unsafe(statement);
      });
    },
  });
}
