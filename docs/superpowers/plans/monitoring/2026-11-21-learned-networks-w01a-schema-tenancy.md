# Learned Networks W01a: Schema and Tenancy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the five learned-network tables, the new columns on five existing tables, their RLS, every
tenancy registration, the database-enforced gated invariant, the device-org-move cleanup and the org-merge
fold. No behavior: nothing reads or writes these tables yet except the triggers and the merge.

**Architecture:** One migration, `2027-01-29-100000-learned-networks.sql`, creates everything, with tenancy
shape 1 on all five tables and composite `DEFERRABLE INITIALLY IMMEDIATE` FKs on every link. Two
constraint triggers make `(gated = false, network assigned)` unrepresentable. A new `BEFORE UPDATE OF
org_id` trigger on `devices` drops a moving device's memberships. The org merge folds identical
fingerprints in its `resolve` phase through a `custom` executor, then repoints the rest.

**Tech stack:** PostgreSQL, hand-written SQL migrations, Drizzle (declarations only), Vitest.

**Spec:** `docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md` (§6).

**Index:** `docs/superpowers/plans/monitoring/2026-11-21-learned-networks.md`. Its Global constraints,
Review focus and Cross-wave contract (sections A1 to A9) apply to every task here; names in it are fixed.

## Wave constraints

- One migration file. It writes no rows, so it elects no `breeze.scope`; trigger bodies elect system scope
  in-body and restore the caller's, as `2027-01-17-200000-device-network-isolations.sql:218-256` does.
  Idempotent throughout (`IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`, `DROP TRIGGER IF
  EXISTS`), no inner `BEGIN`/`COMMIT`.
- Do not redefine `breeze_device_child_orgid_tables()` or `breeze_cascade_device_org_id()`; later
  migrations redefine both. This feature adds its own trigger (Task 2).
- Fixtures use only the index's synthetic values. Assert FK refusals with `isPgForeignKeyViolation`
  (`apps/api/src/utils/pgErrors.ts`), never a bare `'23503'`.
- Integration commands need `pnpm test-stack up` first and `pnpm test-stack down` at the end. The
  contract suites are red between Task 1 and Task 3 by design; each task runs its own tests.

## Decisions this plan makes

1. **A5 is a new trigger, `breeze_learned_networks_device_moved`, BEFORE UPDATE OF org_id on `devices`.**
   It deletes the device's `learned_network_devices` rows and nulls the four `network_attachment*`
   columns on `NEW`. It is a no-op when `OLD.org_id` is in status `merging`, the test
   `breeze_topology_presence_device_moved` uses
   (`2026-12-27-000000-topology-presence-days-and-confirmation.sql:129-131`). It is safe on a device org
   move because `moveDeviceOrgInTransaction` flips `devices.org_id` first
   (`services/deviceOrgMove/moveDeviceOrgInTransaction.ts:566-580`). The BEFORE trigger empties the table
   for that device before the AFTER restamp (`breeze_cascade_device_org_id()`) runs, so nothing is carried
   into the target org. The app restamp loop skips move-delete tables (`:970-979`), and the app delete loop
   (`:1064-1066`) finds nothing. Every other `org_id` writer is covered by the same trigger. A forged
   `merging` status only keeps the rows, and the non-deferred `(gateway_id, org_id)` FK then aborts the
   move.
2. **A7 runs in the merge's `resolve` phase** while every row is still under the loser, joining by ids and
   never by `org_id`. `SET CONSTRAINTS ALL DEFERRED` (`services/orgMerge.ts:1495`) covers the window in
   which a loser row names a survivor gateway, including the A6 constraint triggers.
3. **A partial fold is a split.** A source network whose fingerprints only partly collide, all into one
   survivor network, is kept, unassigned, without the folded fingerprints (Contract notes).
4. **Unique keys.** `devices_id_org_id_uniq` and `sites_id_org_id_uniq` exist
   (`db/schema/devices.ts:444`, `db/schema/orgs.ts:371`). `discovery_profiles` has none; the migration adds
   `discovery_profiles_id_org_id_uniq`.
5. **Partner-export material state.** The `devices` and `sites` update triggers compare a fixed list of
   columns (`2026-07-18-partner-export-org-locks.sql:272-294`, `:310-330`), so the new columns there are
   not material. The `discovered_assets` trigger compares every column except an `excluded` list, so
   `last_network_id` would count as material, and every W03a stamp on an approved equipment asset would
   take the org's exclusive export lock. The partner export does not publish it. The migration therefore
   redefines `breeze_partner_export_site_child_update()` verbatim from its newest definition
   (`2026-10-28-100000-partner-export-child-update-lock-on-change.sql:93-135`), with `'last_network_id'`
   appended to the `discovered_assets` array, as `2026-10-15-150600-network-baseline-recurring-authority.sql`
   did for `network_baselines`. No later migration redefines it.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `apps/api/migrations/2027-01-29-100000-learned-networks.sql` | create | All DDL, RLS, A5 and A6 triggers |
| `apps/api/src/db/schema/learnedNetworks.ts` | create | Five Drizzle tables and their in-file composite FKs |
| `apps/api/src/db/schema/{index.ts:220, discovery.ts:102-230, orgs.ts:349-373, devices.ts:438}` | modify | barrel export; the A4 columns, one unique, two checks |
| `apps/api/src/services/tenantCascade.ts` | modify (`:262`) | cascade order |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | modify (`:51`) | export classification |
| `apps/api/src/services/orgMergeRegistry.ts` | modify (`:134`, `:851`) | merge policies |
| `apps/api/src/services/orgMergeCustomExecutors.ts` | modify (`:2081`, `:2135`, `:2215`) | fold executor |
| `apps/api/src/services/learnedNetworks/orgMerge.ts` | create | the fold (keeps the executor file from growing) |
| `apps/api/src/services/deviceCascadeTables.ts:138`, `apps/api/src/routes/devices/core.ts:237,405`, `apps/api/src/services/deviceInstallBoundary/classification.ts:101` | modify | device lists |
| `apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts` | modify (`:323`) | benign trigger entry |
| `apps/api/src/__tests__/integration/learnedNetworksTenancy.integration.test.ts` | create | P6, FKs, A5, A6, T7 |
| `apps/api/src/__tests__/integration/learnedNetworksOrgMerge.integration.test.ts` | create | A7, S8, T6 |

---

### Task 1: Tables, columns, constraints and RLS

**Files:**
- Create: `apps/api/migrations/2027-01-29-100000-learned-networks.sql`
- Create: `apps/api/src/db/schema/learnedNetworks.ts`
- Modify: `apps/api/src/db/schema/index.ts`, `discovery.ts`, `orgs.ts`, `devices.ts`
- Test: `apps/api/src/__tests__/integration/learnedNetworksTenancy.integration.test.ts`

**Interfaces:**
- Produces: Drizzle exports `learnedNetworks`, `learnedNetworkGateways`, `learnedNetworkDevices`,
  `learnedNetworkWanAddresses`, `discoveryProfileSnmpGrants`. New properties:
  `sites.discoveryNetworkRequired`; `devices.networkAttachmentEpoch`, `networkAttachmentSequence`
  (`bigint` `{ mode: 'number' }`), `networkAttachmentDigest`, `networkAttachmentsConfirmedAt` (these four
  equal the keys of `AttachmentDeviceFields`, index E3); `discoveryProfiles.networkId`, `snmpGrantMode`
  (`$type<'unrestricted' | 'bound'>()`); `discoveryJobs.networkId`, `networkDispatch`
  (`jsonb … $type<Record<string, unknown>>()`), `crossNetworkAssetUpdates`; `discoveredAssets.lastNetworkId`.

Pattern to copy for the test file: `topologyExclusionsRls.integration.test.ts`. It runs on the `breeze_app`
pool, asserts the role is non-bypass, seeds through `withDbAccessContext(orgContext(orgId))`
(`topology-fixtures.ts:4`), and forges across orgs.

- [ ] **Step 1: Write the failing test.** Fixture `twoOrgs()`: two tenants (`createPartner`,
  `createOrganization`, `createSite`, `createDevice` from `db-utils.ts`). In each, seed one network
  (`prefix '192.168.1.0/24'`), gateway `(192.168.1.1, a4:2b:b0:11:22:9c)`, device row
  (`interface_name 'Ethernet'`, `local_address '192.168.1.57'`), WAN row `203.0.113.20`, one discovery
  profile and one grant, as `breeze_app` in that org's context.

```ts
const TABLES = ['learned_networks', 'learned_network_gateways', 'learned_network_devices',
  'learned_network_wan_addresses', 'discovery_profile_snmp_grants'] as const;

it('every table has RLS enabled and forced with the four org-isolation policies', async () => {
  // per table: pg_class relrowsecurity and relforcerowsecurity both true; pg_policies names equal
  // ['breeze_org_isolation_delete', 'breeze_org_isolation_insert', 'breeze_org_isolation_select',
  //  'breeze_org_isolation_update']; and current_user is breeze_app with rolbypassrls false.
});

it.each(TABLES)('P6 %s: org B cannot read, change, delete or forge org A rows', async (t) => {
  // SELECT/UPDATE/DELETE of A's row under B's context return 0 rows;
  // INSERT of a row with org_id = A under B's context rejects with code 42501;
  // UPDATE ... SET org_id = B on A's row under A's context rejects with 42501.
});

it('every composite FK is deferrable, initially immediate, with the A2 action', async () => {
  const rows = await db.execute(sql`SELECT conname, condeferrable, condeferred, confdeltype,
    (SELECT array_agg(attname ORDER BY attname) FROM pg_attribute WHERE attrelid = conrelid AND attnum = ANY (confdelsetcols)) AS setcols
    FROM pg_constraint WHERE contype = 'f' AND conname = ANY (${A2_FKS.map((f) => f.name)})`);
  expect(rows).toHaveLength(10);
  for (const f of A2_FKS) expect(rows.find((r) => r.conname === f.name))
    .toMatchObject({ condeferrable: true, condeferred: false, confdeltype: f.action, setcols: f.setcols });
});

it.each(A2_FKS)('cross-org reference through $name is refused', async (fk) => {
  // Under org A's context, write a row whose fk column names org B's parent (B's site, network,
  // gateway, device or profile). Expect isPgForeignKeyViolation(err, fk.name) === true.
});

it('T7 two rows per device', async () => {
  // one device behind two gateways of one network
  // Add gateway (10.1.2.100, 00:1a:8c:00:00:01) to A's network; insert a second device row on it
  // ('Wi-Fi', '10.1.2.57'). Both rows exist. A duplicate (device_id, gateway_id) insert rejects with
  // isPgUniqueViolation(err, 'learned_network_devices_device_gateway_uniq').
});

it('deleting a network a profile points at is refused; a job or asset link is nulled', async () => {
  // profile.network_id = N  -> DELETE N rejects, isPgForeignKeyViolation(err, 'discovery_profiles_network_fk')
  // clear the profile, point a job and an asset at N -> DELETE N succeeds;
  // job.network_id IS NULL, asset.last_network_id IS NULL, both rows still exist.
});

it('stamping discovered_assets.last_network_id is not partner-export material', async () => {
  // approved 'router' asset at 192.168.1.1 on A's site; prime with breeze_partner_export_touch_sites and
  // read siteState(site) as partnerApiReconstructionWatermark.integration.test.ts:353-385 does.
  // UPDATE discovered_assets SET last_network_id = A's network -> inventory timestamp unchanged.
  // Control: UPDATE … SET hostname = 'DESKTOP-01' on the same asset -> inventory timestamp advances.
});

it('check constraints refuse an assigned and ignored network, IPv6 or non-host addresses, a bad grant mode and an oversized dispatch', async () => {
  // each rejects with code 23514: site_id and ignored_at both set; gateway_address '::1';
  // gateway_address '192.168.1.0/24'; local_address 'fe80::1'; snmp_grant_mode 'any';
  // network_dispatch = jsonb object whose text is 16,385 bytes. A 16,384-byte object is accepted.
});
```

`A2_FKS` is the ten rows of index A2 with these names and `confdeltype` (`c` cascade, `n` set null,
`a` no action) and `setcols` (`null` unless set-null):

| Name | Action | setcols |
|---|---|---|
| `learned_networks_site_fk` | `n` | `{site_id}` |
| `learned_network_gateways_network_fk` | `c` | null |
| `learned_network_devices_device_fk` | `c` | null |
| `learned_network_devices_gateway_fk` | `c` | null |
| `learned_network_wan_addresses_network_fk` | `c` | null |
| `discovery_profile_snmp_grants_profile_fk` | `c` | null |
| `discovery_profile_snmp_grants_gateway_fk` | `c` | null |
| `discovery_profiles_network_fk` | `a` | null |
| `discovery_jobs_network_fk` | `n` | `{network_id}` |
| `discovered_assets_last_network_fk` | `n` | `{last_network_id}` |

- [ ] **Step 2: Run it and see it fail.** `pnpm test-stack up`, then
  `pnpm --filter @breeze/api test:integration src/__tests__/integration/learnedNetworksTenancy.integration.test.ts`.
  Expected: FAIL, `relation "learned_networks" does not exist`.

- [ ] **Step 3: Write the migration DDL.** Columns are index table A. Types and defaults the index leaves
  open: every `org_id` is `uuid NOT NULL REFERENCES organizations(id)`; every `id` is
  `uuid PRIMARY KEY DEFAULT gen_random_uuid()`; `network_id`, `device_id`, `gateway_id`, `profile_id` are
  `uuid NOT NULL`; `first_seen_at`, `last_seen_at`, `created_at`, `updated_at`, `granted_at` are
  `timestamptz NOT NULL DEFAULT now()`; `ignored_at`, `assigned_at` are `timestamptz`; `is_primary` is
  `boolean NOT NULL DEFAULT false`; `is_current` is `boolean NOT NULL DEFAULT true`; `assigned_by` and
  `granted_by` are `uuid REFERENCES users(id) ON DELETE SET NULL`. New columns on existing tables are A4,
  all nullable except the two `NOT NULL DEFAULT`s it names.

Constraints, exactly:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS discovery_profiles_id_org_id_uniq ON discovery_profiles (id, org_id);

-- inside CREATE TABLE learned_networks
  CONSTRAINT learned_networks_id_org_uniq UNIQUE (id, org_id),
  CONSTRAINT learned_networks_site_fk FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id)
    ON DELETE SET NULL (site_id) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT learned_networks_assigned_or_ignored_chk CHECK (site_id IS NULL OR ignored_at IS NULL),
  CONSTRAINT learned_networks_prefix_ipv4_chk CHECK (prefix IS NULL OR family(prefix) = 4)
-- inside CREATE TABLE learned_network_gateways
  CONSTRAINT learned_network_gateways_id_org_uniq UNIQUE (id, org_id),
  CONSTRAINT learned_network_gateways_fingerprint_uniq UNIQUE (org_id, gateway_mac, gateway_address),
  CONSTRAINT learned_network_gateways_network_fk FOREIGN KEY (network_id, org_id)
    REFERENCES learned_networks (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT learned_network_gateways_ipv4_host_chk
    CHECK (family(gateway_address) = 4 AND masklen(gateway_address) = 32)
-- inside CREATE TABLE learned_network_devices
  CONSTRAINT learned_network_devices_device_gateway_uniq UNIQUE (device_id, gateway_id),
  CONSTRAINT learned_network_devices_device_fk FOREIGN KEY (device_id, org_id)
    REFERENCES devices (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT learned_network_devices_gateway_fk FOREIGN KEY (gateway_id, org_id)
    REFERENCES learned_network_gateways (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT learned_network_devices_ipv4_host_chk
    CHECK (family(local_address) = 4 AND masklen(local_address) = 32)
-- inside CREATE TABLE learned_network_wan_addresses
  CONSTRAINT learned_network_wan_addresses_network_address_uniq UNIQUE (network_id, address),
  CONSTRAINT learned_network_wan_addresses_network_fk FOREIGN KEY (network_id, org_id)
    REFERENCES learned_networks (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
-- inside CREATE TABLE discovery_profile_snmp_grants
  CONSTRAINT discovery_profile_snmp_grants_profile_gateway_uniq UNIQUE (profile_id, gateway_id),
  CONSTRAINT discovery_profile_snmp_grants_profile_fk FOREIGN KEY (profile_id, org_id)
    REFERENCES discovery_profiles (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT discovery_profile_snmp_grants_gateway_fk FOREIGN KEY (gateway_id, org_id)
    REFERENCES learned_network_gateways (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE

-- on existing tables, each in its own DO $$ … EXCEPTION WHEN duplicate_object block
ALTER TABLE discovery_profiles ADD CONSTRAINT discovery_profiles_network_fk FOREIGN KEY (network_id, org_id)
  REFERENCES learned_networks (id, org_id) DEFERRABLE INITIALLY IMMEDIATE;          -- NO ACTION: blocks
ALTER TABLE discovery_profiles ADD CONSTRAINT discovery_profiles_snmp_grant_mode_chk
  CHECK (snmp_grant_mode IN ('unrestricted', 'bound'));
ALTER TABLE discovery_jobs ADD CONSTRAINT discovery_jobs_network_fk FOREIGN KEY (network_id, org_id)
  REFERENCES learned_networks (id, org_id) ON DELETE SET NULL (network_id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE discovery_jobs ADD CONSTRAINT discovery_jobs_network_dispatch_chk CHECK (network_dispatch IS NULL
  OR (jsonb_typeof(network_dispatch) = 'object' AND octet_length(network_dispatch::text) <= 16384));
ALTER TABLE discovered_assets ADD CONSTRAINT discovered_assets_last_network_fk FOREIGN KEY (last_network_id, org_id)
  REFERENCES learned_networks (id, org_id) ON DELETE SET NULL (last_network_id) DEFERRABLE INITIALLY IMMEDIATE;
```

Indexes (all `IF NOT EXISTS`): `learned_networks_org_site_idx (org_id, site_id)`;
`learned_networks_site_idx (site_id) WHERE site_id IS NOT NULL`; `learned_networks_retention_idx
(last_seen_at) WHERE site_id IS NULL AND ignored_at IS NULL`; `learned_network_gateways_network_idx
(network_id)`; `learned_network_devices_gateway_idx (gateway_id)`; `learned_network_devices_current_idx
(gateway_id, device_id) WHERE is_current`; `learned_network_devices_last_seen_idx (last_seen_at)`;
`discovery_profile_snmp_grants_gateway_idx (gateway_id)`; and `…_network_idx` partial indexes
`WHERE <col> IS NOT NULL` on `discovery_profiles (network_id)`, `discovery_jobs (network_id)`,
`discovered_assets (last_network_id)`.

RLS: `ENABLE` and `FORCE ROW LEVEL SECURITY` on the five tables, then the policy and grant loop copied
from `2026-12-25-140000-topology-presence-read-model.sql:92-119` with the array
`ARRAY['learned_networks','learned_network_gateways','learned_network_devices','learned_network_wan_addresses','discovery_profile_snmp_grants']`.

Partner export (decision 5): `CREATE OR REPLACE FUNCTION public.breeze_partner_export_site_child_update()`
copied byte for byte from `2026-10-28-100000-partner-export-child-update-lock-on-change.sql:93-135`, with
`'last_network_id'` added at the end of the `WHEN 'discovered_assets' THEN ARRAY[…]` list and a comment
naming this file. Replays must go through `replayMigration` (`apps/api/migrations/README.md:193-200`).

- [ ] **Step 4: Write the Drizzle schema.** `learnedNetworks.ts` imports `organizations`, `sites`, `devices`,
  `users` and `discoveryProfiles`. It declares the six CASCADE composite FKs of A2 with
  `foreignKey({ name, columns, foreignColumns }).onDelete('cascade')`. `moveOrg.coverage.test.ts:390`
  reads `learned_network_devices_gateway_fk` from Drizzle, and `cascadeDelete.test.ts` reads the device
  FK. The `SET NULL (col)` and NO ACTION FKs stay SQL-only, with a comment naming the migration, as
  `discoveryProfiles.pinnedDeviceId` does (`discovery.ts:122-131`). `discovery.ts` gains the A4 columns,
  `discovery_profiles_id_org_id_uniq` and both checks, and must not import `learnedNetworks.ts`, which
  would be an import cycle. Uniques and checks use their SQL names.

- [ ] **Step 5: Migrate and run the test.** `pnpm db:migrate && pnpm db:check-drift`, then the Step 2
  command. Expected: PASS, every case. Also `cd apps/api && npx vitest run src/db/autoMigrate.test.ts
  src/db/migrationRlsScope.test.ts src/db/migrationPartnerExportLocks.test.ts`: PASS.

- [ ] **Step 6: Re-check the migration slot.** `git fetch origin main`, then the `Rule 3` command
  (`apps/api/migrations/README.md:243-248`) against `HEAD` and against `origin/main`. If either prints a name
  sorting after `2027-01-29-100000-learned-networks.sql`, rename upward and update this plan and the index.

- [ ] **Step 7: Commit.** `git add` the migration, the schema files and the test file;
  `git commit -m "feat(api): learned networks schema, RLS and composite tenancy FKs"`.

---

### Task 2: Gated-invariant triggers (A6) and device org-move cleanup (A5)

**Files:**
- Modify: `apps/api/migrations/2027-01-29-100000-learned-networks.sql` (append)
- Modify: `apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts:323` (`ORG_ID_BENIGN_TRIGGERS`)
- Test: `apps/api/src/__tests__/integration/learnedNetworksTenancy.integration.test.ts`

**Interfaces:**
- Produces: triggers `learned_networks_site_gated_chk`, `sites_network_required_chk`,
  `breeze_learned_networks_device_moved`. Later waves rely on: assigning a network to a site requires
  `sites.discovery_network_required = true` in the same transaction (any order, checked when the statement
  ends or at commit under deferral), and clearing it requires the site to have no assigned network.

- [ ] **Step 1: Write the failing tests** (same file).

```ts
it('A6: assigning a network to a site that is not gated is refused', async () => {
  // site.discovery_network_required = false; UPDATE learned_networks SET site_id = site
  // -> rejects, code 23514, message starts 'learned_network_site_not_gated:'.
  // Same with INSERT of an already-assigned network.
  // Set the flag true first, in the same transaction -> succeeds.
  // Assign first, then set the flag, inside one transaction with SET CONSTRAINTS ALL DEFERRED -> commits.
});

it('A6: clearing the gated flag while a network is assigned is refused', async () => {
  // gated site with one assigned network: UPDATE sites SET discovery_network_required = false
  // -> rejects 23514 'site_network_still_assigned:'. Unassign (site_id = NULL), then clear -> succeeds.
});

it('A6: deleting a gated site unassigns its networks without tripping either trigger', async () => {
  // DELETE the site -> network.site_id IS NULL, network row kept.
});
it('A5: a device org move deletes its memberships and clears the four attachment columns', async () => {
  // device in org A with a membership and all four devices.network_attachment* set.
  // admin: UPDATE devices SET org_id = B, site_id = B's site (as
  // deviceNetworkIsolationsSchema.integration.test.ts:163 does).
  // -> learned_network_devices has no row for the device; the four columns are NULL;
  // A's gateway and network rows are untouched.
});

it('A5: a site-only move keeps memberships and the attachment columns', async () => {
  // UPDATE devices SET site_id = a second site of org A -> the row and all four columns unchanged.
});
```

- [ ] **Step 2: Run and see them fail.** Same command as Task 1 Step 2. Expected: the A6 cases fail
  because the update succeeds, and the A5 org-move case fails with a foreign-key violation on
  `learned_network_devices_gateway_fk`. That failure is the restamp the trigger exists to prevent.

- [ ] **Step 3: Append the triggers.** The trigger DDL is exact:

```sql
DROP TRIGGER IF EXISTS learned_networks_site_gated_chk ON public.learned_networks;
CREATE CONSTRAINT TRIGGER learned_networks_site_gated_chk
  AFTER INSERT OR UPDATE OF site_id ON public.learned_networks
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW WHEN (NEW.site_id IS NOT NULL)
  EXECUTE FUNCTION public.breeze_learned_network_site_gated_check();

DROP TRIGGER IF EXISTS sites_network_required_chk ON public.sites;
CREATE CONSTRAINT TRIGGER sites_network_required_chk
  AFTER UPDATE OF discovery_network_required ON public.sites
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW WHEN (NEW.discovery_network_required = false)
  EXECUTE FUNCTION public.breeze_site_network_required_check();

DROP TRIGGER IF EXISTS breeze_learned_networks_device_moved ON public.devices;
CREATE TRIGGER breeze_learned_networks_device_moved
  BEFORE UPDATE OF org_id ON public.devices FOR EACH ROW
  WHEN (NEW.org_id IS DISTINCT FROM OLD.org_id)
  EXECUTE FUNCTION public.breeze_learned_networks_device_moved();
```

  The three functions are `plpgsql SECURITY DEFINER SET search_path = pg_catalog, public`. Each saves
  `current_setting('breeze.scope', true)`, sets `system` for its reads and writes, and restores the saved
  value before it raises or returns, as in `2027-01-17-200000-device-network-isolations.sql:218-246`.
  Each ends with `REVOKE ALL ON FUNCTION … FROM PUBLIC`.
  - `breeze_learned_network_site_gated_check()` re-reads the network by `NEW.id`, not from `NEW`, because
    under deferral it runs at commit. If its current `site_id` is not null and that site's
    `discovery_network_required IS DISTINCT FROM true`, it raises
    `learned_network_site_not_gated: network % is assigned to site % whose discovery_network_required is false`
    with `ERRCODE = '23514'`. It returns `NULL`.
  - `breeze_site_network_required_check()` re-reads the site by `NEW.id`. If the flag is not true and
    `EXISTS (SELECT 1 FROM learned_networks WHERE site_id = NEW.id)`, it raises
    `site_network_still_assigned: site % has an assigned learned network` with `ERRCODE = '23514'`.
  - `breeze_learned_networks_device_moved()`: unless
    `EXISTS (SELECT 1 FROM organizations o WHERE o.id = OLD.org_id AND o.status::text = 'merging')`, it
    runs `DELETE FROM learned_network_devices WHERE device_id = OLD.id` and sets
    `NEW.network_attachment_epoch`, `NEW.network_attachment_sequence`, `NEW.network_attachment_digest` and
    `NEW.network_attachments_confirmed_at` to `NULL`. It returns `NEW` and never raises.

- [ ] **Step 4: Classify the device trigger for the merge contract.** Add to `ORG_ID_BENIGN_TRIGGERS`:
  `'devices.breeze_learned_networks_device_moved': 'no-op while OLD.org_id is merging (the merge folds learned_network_devices with its fingerprints); outside a merge deletes the device\'s learned_network_devices rows and nulls the network_attachment_* columns; never RAISEs or reverts org_id'`.

- [ ] **Step 5: Run the tests.** `pnpm db:migrate`, then the tenancy file and
  `pnpm --filter @breeze/api test:integration src/__tests__/integration/orgMergeRegistry.integration.test.ts`.
  Expected: PASS. The registry suite's other cases may still fail on the missing merge policies; they
  are fixed in Task 3.

- [ ] **Step 6: Commit.** `git commit -m "feat(api): gated-site invariant triggers and device org-move cleanup for learned networks"`.

---

### Task 3: Tenancy registrations

**Files:** the eight list files in the File structure table (rows `tenantCascade.ts` to
`classification.ts`), plus `apps/api/src/services/orgMergeCustomExecutors.ts`.

**Interfaces:**
- Produces: `CUSTOM_EXECUTORS.learned_networks` (the move half). Task 4 adds the resolve half.

- [ ] **Step 1: Run the contract suites and see them fail** on the new tables.
  `cd apps/api && npx vitest run src/routes/devices/moveOrg.coverage.test.ts src/routes/devices/cascadeDelete.test.ts`:
  FAIL, naming `learned_network_devices`. Then run each of these with
  `pnpm --filter @breeze/api test:integration <file>`: `tenantCascade.integration.test.ts`,
  `tenant-export-policy.integration.test.ts`, `installBoundaryContract.integration.test.ts`. Each FAILS,
  naming the new tables or columns. (`orgMergeRegistry` derives its required set from the cascade list, so
  it cannot go red before the cascade entry exists; it is in Step 3.)

- [ ] **Step 2: Add the entries.**

| List | Entry |
|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts:262`, alphabetical by `localeCompare`) | `'discovery_profile_snmp_grants'` between `'discovery_jobs'` and `'discovery_profiles'`; `'learned_network_devices'`, `'learned_network_gateways'`, `'learned_network_wan_addresses'`, `'learned_networks'` in that order, before `'legacy_labour_pricing_archive'` |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` (`deviceCascadeTables.ts:138`) | `'learned_network_devices'` |
| `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`routes/devices/core.ts:237`) | `'learned_network_devices'`, with a comment that the BEFORE trigger deletes its rows on a cross-org move and the restamp loop skips it as a move-delete table |
| `CORE_DEVICE_ORG_MOVE_DELETE_TABLES` (`core.ts:405`) | `'learned_network_devices'`: `(gateway_id, org_id)` names a source-org fingerprint; the next report rebuilds memberships in the target org |
| `INSTALL_BOUNDARY_CLASSIFICATION` (`classification.ts:101`, alphabetical) | `learned_network_devices: history('learned network sightings; the next attachment report replaces them')` |
| `SPECIAL` (`orgMergeRegistry.ts:134`) | `learned_networks: { kind: 'custom', note: 'fold identical fingerprints (gateway_mac, gateway_address) into the survivor in RESOLVE: re-point device rows and grants to the survivor fingerprint, merge a network whose fingerprints all fold into one survivor network, unassign one that would split; MOVE repoints the rest (learnedNetworks/orgMerge.ts)' }` |
| `REPOINT_TABLES` (`orgMergeRegistry.ts:851`, alphabetical) | `'discovery_profile_snmp_grants'`, `'learned_network_devices'`, `'learned_network_gateways'`, `'learned_network_wan_addresses'`. Comment: colliding fingerprints are already gone after the `learned_networks` resolve half, so a plain repoint cannot hit `learned_network_gateways_fingerprint_uniq` |
| `CUSTOM_EXECUTORS` (`orgMergeCustomExecutors.ts:2081`) | `learned_networks: moveLearnedNetworks`, where `moveLearnedNetworks` returns `{ moved: await run(buildRepoint('learned_networks', loser, survivor)), dropped: 0, notes: [] }`, the shape of `moveDiscoveredAssets` (`:237-241`) |

`CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts:51`): add a `tablePolicy('org_id', …)` per new
table, with every column in `included` and the other three groups empty. On existing tables, add
`discovery_network_required` to `"sites"` (`:947`) `included`; the four `network_attachment*` columns to
`"devices"` (`:496`) `included`; `network_id` and `snmp_grant_mode` to `"discovery_profiles"` (`:511`)
`included`; `network_id` and `cross_network_asset_updates` to `"discovery_jobs"` (`:510`) `included` and
`network_dispatch` to its `excludedOpen`; `last_network_id` to `"discovered_assets"` (`:509`)
`included`. No new column name matches `SUSPICIOUS_NAME_PARTS` (`services/tenantExportPolicy.ts:42-62`).

No `orgCascadeFkOnDelete` ledger line is needed. Every new edge is CASCADE, a nullable `SET NULL`, or NO
ACTION with both tables in the cascade set (`discovery_profiles -> learned_networks`). Erasure handles
those through rules (a), (b) and (d) of `orgCascadeFkOnDelete.integration.test.ts:47-61`.

- [ ] **Step 3: Run the suites.** Step 1's commands plus `orgMergeRegistry.integration.test.ts`,
  `orgCascadeFkOnDelete.integration.test.ts`, `orgLifecycleFoundations.integration.test.ts`,
  `tenantExportErasureRoundtrip.integration.test.ts`, `deviceOwnershipEpochs.integration.test.ts`, and
  `cd apps/api && npx vitest run src/services/orgMerge.test.ts src/services/orgMergeRegistry.extensions.test.ts`.
  Expected: PASS everywhere.

- [ ] **Step 4: Commit.** `git commit -m "feat(api): register learned-network tables in tenancy lists"`.

---

### Task 4: Org-merge fold (A7)

**Files:**
- Create: `apps/api/src/services/learnedNetworks/orgMerge.ts`
- Modify: `apps/api/src/services/orgMergeCustomExecutors.ts` (`CUSTOM_RESOLVE_EXECUTORS` `:2135`, `CUSTOM_WOULD_DROP_COUNTS` `:2215`)
- Test: `apps/api/src/__tests__/integration/learnedNetworksOrgMerge.integration.test.ts`

**Interfaces:**
- Consumes: `CustomMergeExecutor`, `MergeTableOutcome` (`orgMergeCustomExecutors.ts:67-73`), imported
  with `import type` so `learnedNetworks/orgMerge.ts` and `orgMergeCustomExecutors.ts` do not form a
  runtime cycle.
- Produces: `export const resolveLearnedNetworks: CustomMergeExecutor` and
  `export function learnedNetworkFoldDropCount(loser: string, survivor: string): SQL` in
  `learnedNetworks/orgMerge.ts`. They are registered as `CUSTOM_RESOLVE_EXECUTORS.learned_networks` and
  `CUSTOM_WOULD_DROP_COUNTS.learned_networks`.

Fixture: as `topologyPresenceOrgMerge.integration.test.ts:26-66`. That means
`ORG_MERGE_FENCE_DRAIN_MS = '0'` in `beforeEach`, a loser from `setupTestEnvironment`, a survivor
`createOrganization` + `createSite` under the same partner, `executeOrgMerge({ loserOrgId, survivorOrgId,
partnerId, performedBy, performedByEmail })`, and seeds and reads through `getTestDb()`. Fingerprints:
`F1 = (192.168.1.1, a4:2b:b0:11:22:9c)`, `F2 = (10.1.2.100, 00:1a:8c:00:00:01)`,
`F3 = (192.168.1.1, 3c:37:86:aa:bb:10)`. Hosts `LAPTOP-JS`, `DESKTOP-01`.

- [ ] **Step 1: Write the failing tests.**

```ts
it('S8 grant re-points only to the identical fingerprint', async () => {
  // loser: network NL {F1}, bound profile PL with a grant on NL.F1.
  // survivor: network NS {F1, F3}.
  // after merge: PL's grants = [NS.F1.id]; no grant names NS.F3; one F1 row in the survivor org;
  // NL deleted; PL.network_id unchanged unless it was NL (then NS).
});

it('T6 split network is kept unassigned', async () => {
  // loser: NL {F1, F2} assigned to loser site L1 (L1 gated); profile PL.network_id = NL;
  //        DESKTOP-01 device rows on NL.F1 and NL.F2.
  // survivor: NS1 {F1}, NS2 {F2}.
  // after merge: NL exists in the survivor org with site_id, assigned_by, assigned_at NULL and no gateways;
  // PL.network_id = NL; DESKTOP-01's rows reference NS1.F1 and NS2.F2 with org_id = survivor;
  // L1.discovery_network_required = true.
});

it('a partial fold is kept unassigned like a split', async () => {
  // loser NL {F1, F2} assigned; survivor NS {F1} only -> NL kept, unassigned, holding F2 only;
  // the F1 device row now references NS.F1. NS gains no gateway.
});

it('a whole fold merges the network and carries the assignment to an unassigned survivor network', async () => {
  // loser NL {F1} assigned to L1, WAN 203.0.113.20 and 198.51.100.7, a profile, a job and an asset
  // pointing at NL. survivor NS {F1} unassigned with WAN 203.0.113.20.
  // after merge: NL gone; profile/job/asset point at NS; NS.site_id = L1 (L1 now in the survivor org);
  // NS WAN = {203.0.113.20, 198.51.100.7}, one row each, first_seen_at = least of the two.
});

it('a whole fold keeps the survivor assignment when both are assigned', async () => {
  // NS assigned to S1, NL to L1 -> NS.site_id = S1; L1 has no network and stays gated.
});

it('a source site keeps discovery_network_required', async () => {
  // gated loser sites with and without an assigned network -> both still true after merge.
});

it('device rows follow their fingerprint through the merge, and the device-move trigger leaves them alone', async () => {
  // LAPTOP-JS in the loser with rows on a colliding (F1) and a non-colliding (F2) fingerprint and all
  // four devices.network_attachment* set. After merge: both rows exist with org_id = survivor; the F1
  // row references the survivor's F1; the F2 gateway moved with its network; the four columns unchanged.
});

it('trims a folded network to 32 WAN addresses, oldest last_seen_at dropped', async () => {
  // NS has 20 WAN rows, NL has 20 distinct ones -> 32 remain, the 8 oldest by last_seen_at are gone.
});
```

- [ ] **Step 2: Run and see them fail.**
  `pnpm --filter @breeze/api test:integration src/__tests__/integration/learnedNetworksOrgMerge.integration.test.ts`.
  Expected: S8, T6, partial fold and both whole-fold cases FAIL with a unique violation on
  `learned_network_gateways_fingerprint_uniq`. The source-site case PASSES already.

- [ ] **Step 3: Implement `resolveLearnedNetworks`.** It runs inside the merge transaction on
  `dbModule.db`, as every executor does. Algorithm:

  1. `pairs` = loser gateway `t` joined to survivor gateway `s` on equal `gateway_mac` and
     `gateway_address` (`t.org_id = loser`, `s.org_id = survivor`), with `t.network_id` and `s.network_id`.
     Also the gateway count of each loser network that appears in `pairs`. No pairs: return
     `{ moved: 0, dropped: 0, notes: [] }` after this one read, so an ordinary merge and the mocked
     `orgMerge.test.ts` see a single statement.
  2. Classify each loser network `N` in `pairs`. It is a **whole fold into `M`** when every one of its
     gateways is in `pairs` and all of them map to one survivor network `M`. Otherwise it is **kept**.
  3. For every pair, in one statement each: `learned_network_devices.gateway_id` `t → s`;
     `discovery_profile_snmp_grants.gateway_id` `t → s`; set `s.first_seen_at = least(…)` and
     `s.last_seen_at = greatest(…)`; delete `t`. Match child rows by `gateway_id = t.id` only, never by
     `org_id`.
  4. For each whole fold `N → M`: re-point `discovery_profiles.network_id`, `discovery_jobs.network_id`
     and `discovered_assets.last_network_id` from `N` to `M`. Upsert `N`'s WAN rows into `M` with
     `org_id = survivor`, `ON CONFLICT (network_id, address)`, `least` first-seen and `greatest`
     last-seen. Delete `N`'s WAN rows. Keep `M`'s 32 newest by `(last_seen_at DESC, id DESC)`. When
     `M.site_id IS NULL AND N.site_id IS NOT NULL`, copy `site_id`, `assigned_by` and `assigned_at`, and set
     `ignored_at = NULL`. Set `M.name = coalesce(M.name, N.name)`, least first-seen and greatest last-seen.
     Delete `N`.
  5. For each kept network that lost a gateway in step 3: `site_id = NULL, assigned_by = NULL,
     assigned_at = NULL, updated_at = now()`.
  6. Return `{ moved: 0, dropped: <gateways deleted + networks deleted>, notes }`. Add a note when step
     4 or 5 changed an assignment: `learned_networks: <n> merged into identical survivor networks, <k>
     left unassigned because their gateways matched more than one survivor network or only some of them`.

  `learnedNetworkFoldDropCount` is the read-only `count(*)` of step 3's deleted gateways plus step 4's
  deleted networks, built from the same `pairs` predicate.

- [ ] **Step 4: Run the tests.** Step 2's command, then
  `orgMergeRegistry.integration.test.ts`, `orgMerge.integration.test.ts`,
  `orgMergeCustomExecutors.integration.test.ts` and
  `cd apps/api && npx vitest run src/services/orgMerge.test.ts src/services/orgMergeCustomExecutors.test.ts`.
  Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(api): fold identical learned-network fingerprints on org merge"`.

---

## Done when

- [ ] `pnpm db:migrate && pnpm db:check-drift` succeeds on a fresh test stack.
- [ ] Task 1 Step 6 run again just before opening the PR; the file still sorts last against `origin/main`.
- [ ] `cd apps/api && npx vitest run src/routes/devices/moveOrg.coverage.test.ts src/routes/devices/cascadeDelete.test.ts src/services/orgMerge.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/db/migrationPartnerExportLocks.test.ts` — all PASS.
- [ ] `pnpm --filter @breeze/api test:integration src/__tests__/integration/<name>.integration.test.ts`
  PASSES for each `<name>`: `learnedNetworksTenancy`, `learnedNetworksOrgMerge`, `tenantCascade`,
  `orgCascadeFkOnDelete`, `orgMergeRegistry`, `orgMerge`, `orgMergeCustomExecutors`,
  `orgLifecycleFoundations`, `tenant-export-policy`, `tenantExportErasureRoundtrip`,
  `installBoundaryContract`, `deviceOwnershipEpochs`, `deviceNetworkIsolationsSchema`,
  `topologyPresenceOrgMerge`.
- [ ] `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` — PASS.
- [ ] `pnpm --filter @breeze/api test:integration-suite-coverage` — PASS.
- [ ] Full `pnpm --filter @breeze/api test` (the merge registry reds only in the full unit run) — PASS.
- [ ] `pnpm test-stack down`.
- [ ] PR body: `Closes #<W01a sub-issue>`; the `org_id NOT NULL` justification from spec §6 (observed
  inventory, nothing partner-wide to define); the migration filename and that it writes no rows; the
  P6 and P7 rows of the index Traceability table with their test files; the A5 mechanism in one sentence;
  the Contract notes below.

## Contract notes

1. **A5 under org merge.** The trigger is a no-op while the source org is `merging`, so A7's fold, not
   A5's delete, decides device rows on a merge; inside the merge transaction a loser row may name a
   survivor gateway under deferred constraints, as every composite FK already may.
2. **A7 does not cover a partial fold.** A source network can have only some of its fingerprints collide,
   all into one survivor network. This plan treats it as a split: kept, unassigned, without the folded
   fingerprints. It is pinned by `a partial fold is kept unassigned like a split`. Merging it instead
   would put an unreviewed gateway into a network that may be assigned.
3. **Constraint on later waves.** Code that deletes `learned_network_gateways` or `learned_network_devices`
   rows outside the ingest must null `devices.network_attachment_digest` for the devices whose current rows
   it removes, or they keep confirming a digest whose memberships are gone. W01b retention does this; the
   W03c replace merge must too.
4. **W01a redefines one shared function** (index A9):
   `breeze_partner_export_site_child_update()`, to keep `discovered_assets.last_network_id` out of partner
   export material state (decision 5). The redefinition is the newest body replayed verbatim plus one array
   entry.
