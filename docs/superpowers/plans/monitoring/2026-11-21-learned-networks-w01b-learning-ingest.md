# Learned Networks W01b: Learning from Heartbeats

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The REST heartbeat learns each device's network attachments into the W01a tables. An unchanged
report costs no write beyond the heartbeat's own device update. Shared timestamps are refreshed by an
hourly batch, a daily job applies retention, and an env var switches ingest off.

**Architecture:** A shared validator parses `networkAttachmentsV1`. A pure planner compares the report
with four columns on the device row the heartbeat already locks, and returns `ignore`, `confirm` (fold a
confirmation time into the existing device update) or `apply`. Only `apply` touches the learned tables,
in a savepoint whose failure is logged and leaves the heartbeat intact. A BullMQ job owns last-seen
refresh and retention.

**Tech stack:** Hono/TypeScript, Zod 4 (`packages/shared`), PostgreSQL + Drizzle, BullMQ, Vitest.

**Spec:** `docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md` (§6
limits and retention, §7.1 report, §8.1 learning).

**Index:** `docs/superpowers/plans/monitoring/2026-11-21-learned-networks.md`. Its Global constraints,
Review focus and Cross-wave contract (B1, C1, E2, E3, E4; plan calls 2, 6 and 7; review focus 2 and 5)
apply to every task here; names in it are fixed.

## Wave constraints

- Depends on W01a (tables, the four `devices.network_attachment*` columns, A5 and A6).
- Agent-path writes to `devices` go only through the heartbeat's existing `updateOwnDeviceRow` call
  (`routes/agents/heartbeat.ts:1760`). `services/learnedNetworks/ingest.ts` never writes `devices`.
- The learner runs in `withDbTransaction` with the catch outside it, never in a `Promise.all`
  (`docs/agents/tenancy-rls.md`, "A catch around a query").
- Fixtures: subnets `192.168.1.0/24` via `192.168.1.1` and `10.1.2.0/24` via `10.1.2.100`; MACs
  `a4:2b:b0:11:22:9c`, `3c:37:86:aa:bb:10`, `00:1a:8c:00:00:01`; WAN `203.0.113.20`, `198.51.100.7`; hosts
  `LAPTOP-JS`, `DESKTOP-01`. Nothing else.
- "Public" WAN means `!isNonPublicAddress(ip)` (`services/ipClassifyOfflineData.ts:124`). It treats the
  documentation ranges the fixtures use as public. `isPrivateIp` (`services/ipRanges.ts:361`) blocks them
  and must not be used here.

## Decisions this plan makes

1. **Reason order** in the planner is `absent`, `disabled`, `ephemeral`, `invalid_report`,
   `stale_sequence`, `capture_time_out_of_bounds`. The first that applies wins.
2. **Absent field (C1).** A heartbeat with no `networkAttachmentsV1` field means "no change": the agent
   reads in the background and attaches each finished report to one beat, so many beats carry none.
   `planNetworkAttachmentIngest` returns `{ kind: 'ignore', reason: 'absent' }` when the value is
   `undefined`, before any other check. It is never `invalid_report`, nothing is confirmed or cleared, the
   four device columns are untouched, and the route does not increment the counter for it. Only an empty,
   complete list means "on no network". (`null` is a malformed report: `invalid_report`.)
3. **Digest** = SHA-256 hex of `JSON.stringify(['v1', report.complete, wan, rows])`, where `rows` is
   `[interfaceName, localAddress, prefixLength, gatewayAddress, gatewayMac, primary]` per attachment,
   sorted by `interfaceName`, then `gatewayAddress`, then `gatewayMac ?? ''` (plain `<`, not
   `localeCompare`). `epoch`, `sequence` and `capturedAt` are not in it. `complete` is, so a complete
   report after an incomplete one with the same list still applies and can clear memberships.
4. **WAN normalization**, inside the planner: the WAN address is kept only when the trusted client IP is
   an IP, is public, and some attachment is `primary` with a non-null `gatewayMac`. Otherwise it is `null`
   (in the digest too). The WAN row goes to that primary attachment's network.
5. **MACs.** Six hex octets separated by `:` or `-`, any case, normalized to lower-case colon form.
   These normalize to `null`, exactly like an absent MAC, and are never `invalid_report`:
   `00:00:00:00:00:00` and `ff:ff:ff:ff:ff:ff` (incomplete neighbour entries), `02:00:00:00:00:00`, and any
   MAC whose first octet has the group bit set (multicast). `02:00:00:00:00:00` is what macOS 27 gives an
   unprivileged process in place of a real link-layer address; stored, it would give every Mac behind any
   gateway at one address the same fingerprint (amended 2026-11-22 after a native run). Any other form
   makes the report `invalid_report`. More than 64 attachments is `invalid_report` (a parse
   bound); 9 to 64 are cut to 8 per B1.
6. **Null MAC (plan call 6).** An attachment with `gatewayMac: null` protects the device's rows that are
   `is_current` and match its `interfaceName`, `localAddress` and gateway address. Those rows are neither
   updated nor cleared. It creates nothing.
7. **Concurrency.** Find existing fingerprints with one read. For each missing one, in ascending
   `(gateway_mac, gateway_address)` order, take
   `pg_advisory_xact_lock(hashtextextended('learned_network_fingerprint:' || org_id || ':' || mac || ':' || address, 0))`,
   re-read, then create. The lock lasts until the heartbeat's outer transaction ends. Membership rows are
   upserted in ascending `gateway_id`. Shared rows (`prefix`, WAN) are written only when different.
8. **The 5,000 cap is soft** under concurrency. At the cap, a new fingerprint is skipped with a warning
   and the digest is still stored. The device learns it when its report next changes.
9. **Cadence.** Last-seen refresh runs hourly at `16 * * * *`. Retention runs daily at `33 17 * * *`, in the
   daily lane (minute ≡ 3 mod 5). Both minutes are unused in `jobs/scheduleRegistry.ts`.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `packages/shared/src/validators/networkAttachments.ts` (+ `.test.ts`) | create | B1 parse and normalize |
| `packages/shared/src/validators/index.ts:1286` | modify | barrel export |
| `apps/api/src/services/learnedNetworks/constants.ts` | create | E2 constants |
| `apps/api/src/services/learnedNetworks/ingest.ts` (+ `.test.ts`) | create | E3 planner, digest, apply |
| `apps/api/src/services/learnedNetworks/maintenance.ts` | create | E4 refresh and retention |
| `apps/api/src/jobs/learnedNetworkMaintenance.ts` (+ `.test.ts`) | create | queue, two schedulers, worker |
| `apps/api/src/config/env.ts`, `config/validate.ts:880,2556`, `system/connections/internalEnvVars.ts:318`, `docker-compose.yml:171`, `deploy/docker-compose.prod.yml:392`, `.env.example:1503` | modify | kill switch |
| `apps/api/src/routes/agents/schemas.ts:210`, `routes/agents/heartbeat.ts:1399-1402`, `routes/metrics.ts:262,897`, `routes/agentWs.ts:937` | modify | wiring, counter, WS schema export |
| `apps/api/src/jobs/scheduleRegistry.ts:78`, `services/workerRegistry.ts:2261`, `services/workerRegistry.test.ts:164`, `__tests__/parkedFanout.contract.test.ts:224` | modify | job registration |
| `apps/api/src/__tests__/integration/learnedNetworksIngest.integration.test.ts` | create | apply and route behavior, P8, T7, RF2, RF5 |
| `apps/api/src/__tests__/integration/learnedNetworksMaintenance.integration.test.ts` | create | refresh and retention |
| `apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts` | modify | P8 statement count |

---

### Task 1: Attachment report validator (B1)

**Files:** Create `packages/shared/src/validators/networkAttachments.ts` and `networkAttachments.test.ts`;
modify `packages/shared/src/validators/index.ts:1286`.

**Interfaces:**
- Produces: exactly B1. `NETWORK_ATTACHMENTS_MAX`, `NetworkAttachment`, `NetworkAttachmentsReport`,
  `parseNetworkAttachmentsReport`.

- [ ] **Step 1: Write the failing test.**

```ts
const att = (o: Partial<NetworkAttachment> = {}) => ({ interfaceName: 'Ethernet', localAddress: '192.168.1.57',
  prefixLength: 24, gatewayAddress: '192.168.1.1', gatewayMac: 'a4:2b:b0:11:22:9c', primary: true, ...o });
const report = (o = {}) => ({ epoch: '9f2c1e7ab4d04c11', sequence: 418, capturedAt: '2026-11-20T15:04:05Z',
  complete: true, attachments: [att()], ...o });

it('accepts the spec example and an empty complete list', () => {
  expect(parseNetworkAttachmentsReport(report())).toEqual({ accepted: true, report: report() });
  expect(parseNetworkAttachmentsReport(report({ attachments: [] }))).toMatchObject({ accepted: true });
});
it('normalizes MACs to lower-case colon form and incomplete entries to null', () => {
  for (const [given, want] of [['A4-2B-B0-11-22-9C', 'a4:2b:b0:11:22:9c'], ['3C:37:86:AA:BB:10', '3c:37:86:aa:bb:10'],
    ['00:00:00:00:00:00', null], ['ff:ff:ff:ff:ff:ff', null], [null, null]] as const) {
    const r = parseNetworkAttachmentsReport(report({ attachments: [att({ gatewayMac: given })] }));
    expect(r.accepted && r.report.attachments[0]!.gatewayMac).toBe(want);
  }
});
it.each(['a42b.b011.229c', 'a4:2b:b0:11:22', 'a4:2b:b0:11:22:9c:00', 'g4:2b:b0:11:22:9c', 'a4:2b-b0:11:22:9c', ''])(
  'rejects MAC %j', (gatewayMac) => {
    expect(parseNetworkAttachmentsReport(report({ attachments: [att({ gatewayMac })] })))
      .toEqual({ accepted: false, reason: 'invalid_report' });
  });
it.each([{ gatewayAddress: 'fe80::1' }, { localAddress: '2001:db8::5' }, { prefixLength: 33 }, { interfaceName: '' },
  { interfaceName: 'x'.repeat(129) }])('rejects attachment %j', (o) => {
  expect(parseNetworkAttachmentsReport(report({ attachments: [att(o)] }))).toMatchObject({ accepted: false });
});
it.each([{ epoch: '9F2C1E7AB4D04C11' }, { epoch: 'abc' }, { sequence: -1 }, { sequence: 1.5 },
  { sequence: Number.MAX_SAFE_INTEGER + 1 }, { capturedAt: 'yesterday' }, { complete: 'yes' }])('rejects %j', (o) => {
  expect(parseNetworkAttachmentsReport(report(o))).toMatchObject({ accepted: false });
});
it('cuts more than 8 attachments to 8, primary first then by interfaceName, and forces complete false', () => {
  const many = ['eth9', 'eth1', 'eth5', 'eth3', 'eth7', 'eth2', 'eth8', 'eth4', 'eth6'].map((n) => att({ interfaceName: n, primary: n === 'eth9' }));
  const r = parseNetworkAttachmentsReport(report({ attachments: many }));
  expect(r.accepted && r.report.attachments.map((a) => a.interfaceName))
    .toEqual(['eth9', 'eth1', 'eth2', 'eth3', 'eth4', 'eth5', 'eth6', 'eth7']);
  expect(r.accepted && r.report.complete).toBe(false);
});
it('rejects more than 64 attachments and anything that is not an object', () => {
  expect(parseNetworkAttachmentsReport(report({ attachments: Array.from({ length: 65 }, () => att()) })).accepted).toBe(false);
  for (const v of [null, 'x', 7, []]) expect(parseNetworkAttachmentsReport(v).accepted).toBe(false);
});
```

- [ ] **Step 2: Run and see it fail.** `cd packages/shared && npx vitest run src/validators/networkAttachments.test.ts`.
  Expected: FAIL, cannot resolve `./networkAttachments`.
- [ ] **Step 3: Implement** with `z.object` (unknown keys stripped), `z.ipv4()`,
  `z.iso.datetime({ offset: true })`, the epoch regex `/^[0-9a-f]{16}$/`, and a MAC transform per
  decision 5. Never throw; failures return `{ accepted: false, reason: 'invalid_report' }`. Add
  `export * from './networkAttachments';` to the validators barrel.
- [ ] **Step 4: Run it.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(shared): network attachment report validator"`.

---

### Task 2: Planner, digest, constants and kill switch

**Files:** Create `apps/api/src/services/learnedNetworks/constants.ts`, `ingest.ts`, `ingest.test.ts`.
Modify `apps/api/src/config/env.ts`, `config/validate.ts` (`:880` schema key, `:2556` guard),
`config/validate.test.ts` (beside `:4216`), `system/connections/internalEnvVars.ts` (a `// LEARNED_*`
group before `// LLM_*` at `:318`), `docker-compose.yml` and `deploy/docker-compose.prod.yml` (`x-api-env`,
beside `NETWORK_ISOLATION_ENABLED` at `:171` and `:392`), `.env.example` (beside `:1503`).

**Interfaces:**
- Consumes: Task 1's `parseNetworkAttachmentsReport`.
- Produces: E2 verbatim; `learnedNetworksIngestEnabled()`; E3's types, `attachmentDigest`,
  `planNetworkAttachmentIngest`.

- [ ] **Step 1: Write the failing tests.** In `ingest.test.ts`, `NOW = new Date('2026-11-20T15:05:00Z')`,
  stored device `{ id, orgId, isEphemeral: false, networkAttachmentEpoch: '9f2c1e7ab4d04c11',
  networkAttachmentSequence: 418, networkAttachmentDigest: <digest of report() with WAN '203.0.113.20'> }`.

```ts
it.each([
  ['absent',    () => {}, {}, undefined],
  ['disabled',  () => vi.stubEnv('LEARNED_NETWORKS_INGEST_ENABLED', 'false'), {}, report({ sequence: 419 })],
  ['ephemeral', () => {}, { isEphemeral: true }, report({ sequence: 419 })],
  ['invalid_report', () => {}, {}, { epoch: 'nope' }],
  ['stale_sequence', () => {}, {}, report({ sequence: 418 })],
  ['stale_sequence', () => {}, {}, report({ sequence: 17 })],
  ['capture_time_out_of_bounds', () => {}, {}, report({ sequence: 419, capturedAt: '2026-11-20T14:54:59Z' })],
  ['capture_time_out_of_bounds', () => {}, {}, report({ sequence: 419, capturedAt: '2026-11-20T15:15:01Z' })],
])('ignores with %s', (reason, arrange, over, raw) => {
  arrange();
  expect(planNetworkAttachmentIngest({ ...DEVICE, ...over }, raw, '203.0.113.20', NOW)).toEqual({ kind: 'ignore', reason });
});
it('first ignore reason wins', () => {
  vi.stubEnv('LEARNED_NETWORKS_INGEST_ENABLED', 'false');
  expect(planNetworkAttachmentIngest({ ...DEVICE, isEphemeral: true }, undefined, null, NOW)).toEqual({ kind: 'ignore', reason: 'absent' });
  vi.unstubAllEnvs();
  expect(planNetworkAttachmentIngest({ ...DEVICE, isEphemeral: true }, { epoch: 'nope' }, null, NOW)).toEqual({ kind: 'ignore', reason: 'ephemeral' });
  expect(planNetworkAttachmentIngest(DEVICE, report({ sequence: 1, capturedAt: '2026-11-19T00:00:00Z' }), null, NOW)).toEqual({ kind: 'ignore', reason: 'stale_sequence' });
});
it('accepts capturedAt exactly 10 minutes either side', () => { /* 14:55:00Z and 15:15:00Z -> not ignored */ });
it('same epoch, higher sequence, same content: confirm with the new sequence and NOW', () => {
  expect(planNetworkAttachmentIngest(DEVICE, report({ sequence: 419 }), '203.0.113.20', NOW)).toEqual({ kind: 'confirm',
    deviceFields: { networkAttachmentEpoch: '9f2c1e7ab4d04c11', networkAttachmentSequence: 419,
      networkAttachmentDigest: DEVICE.networkAttachmentDigest, networkAttachmentsConfirmedAt: NOW } });
});
it('a different epoch replaces stored state even with a lower sequence', () => {
  // epoch '0000000000000001', sequence 1, same content -> confirm with that epoch and sequence 1;
  // same with changed content -> apply.
});
it('changed content, a changed WAN, or complete flipping each produce apply', () => {
  for (const [raw, wan] of [[report({ sequence: 419, attachments: [att({ localAddress: '192.168.1.58' })] }), '203.0.113.20'],
    [report({ sequence: 419 }), '198.51.100.7'], [report({ sequence: 419, complete: false }), '203.0.113.20']] as const)
    expect(planNetworkAttachmentIngest(DEVICE, raw, wan, NOW)).toMatchObject({ kind: 'apply', deviceFields: { networkAttachmentSequence: 419 } });
});
it('first report on a device with no stored state applies', () => {
  const fresh = { ...DEVICE, networkAttachmentEpoch: null, networkAttachmentSequence: null, networkAttachmentDigest: null };
  expect(planNetworkAttachmentIngest(fresh, report({ sequence: 0 }), null, NOW)).toMatchObject({ kind: 'apply', wanAddress: null });
});
it('WAN is kept only when public and a primary attachment has a MAC', () => {
  // '192.168.1.20', '10.1.2.57', 'unknown', null -> apply.wanAddress null;
  // primary attachment with gatewayMac null -> null; no primary attachment -> null; '198.51.100.7' -> kept.
});
it('attachmentDigest ignores epoch, sequence, capturedAt and attachment order, and changes with every other field', () => {
  // equal for reordered attachments and different epoch/sequence/capturedAt; 64 hex chars;
  // different for each of interfaceName, localAddress, prefixLength, gatewayAddress, gatewayMac, primary,
  // complete, and wan.
});
```

In `validate.test.ts`, copy the `FLOWS_ENABLED boolean guard` block (`:4216-4236`) for
`LEARNED_NETWORKS_INGEST_ENABLED`, with message `/LEARNED_NETWORKS_INGEST_ENABLED must be a boolean/`.
In `ingest.test.ts`: `learnedNetworksIngestEnabled()` is true for unset and `''`, false for `'false'` and `'0'`.

- [ ] **Step 2: Run and see them fail.**
  `cd apps/api && npx vitest run src/services/learnedNetworks/ingest.test.ts src/config/validate.test.ts`.
  Expected: FAIL, cannot resolve `./ingest`; the validate case fails because the key is not in the schema.
- [ ] **Step 3: Implement.** `constants.ts` is E2 verbatim. `learnedNetworksIngestEnabled()` is
  `envFlag('LEARNED_NETWORKS_INGEST_ENABLED', true)`, read at call time. `envFlag` treats `''` as unset
  (`config/env.ts:12-16`). The validate schema key is `z.string().optional()`, plus a guard shaped like
  `FLOWS_ENABLED`'s. Map it in both compose files as `LEARNED_NETWORKS_INGEST_ENABLED: ${LEARNED_NETWORKS_INGEST_ENABLED:-}`.
  `.env.example` gets `# LEARNED_NETWORKS_INGEST_ENABLED=true`, with a comment: learned-network heartbeat
  ingest, default on; off stops learning and confirmations, and gated sites then fail closed. The
  `internalEnvVars.ts` entry is `'learned networks heartbeat ingest kill switch (default on)'`.
  `planNetworkAttachmentIngest` follows decisions 1 to 4 and E3. It is pure: no DB, and reads only
  the env flag.
- [ ] **Step 4: Run** Step 2's command plus `src/system/connections/envInventory.test.ts
  src/config/envReadComposeCoverage.test.ts src/config/envComposeParity.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(api): learned network ingest planner, digest and kill switch"`.

---

### Task 3: Applying a membership change

**Files:** Modify `apps/api/src/services/learnedNetworks/ingest.ts`. Create
`apps/api/src/__tests__/integration/learnedNetworksIngest.integration.test.ts` (describe block
`applyNetworkAttachmentChange`).

**Interfaces:**
- Produces: `applyNetworkAttachmentChange(device, plan, now)` exactly as E3. It writes only learned
  tables and uses the ambient `db` (the caller's context and savepoint).

Fixture: an org, a site, `LAPTOP-JS` and `DESKTOP-01` via `createDevice`, and helper
`applyFor(device, raw, wan, sequence)`. The helper builds a plan with `planNetworkAttachmentIngest` and
runs `withDbAccessContext(orgContext(orgId), () => withDbTransaction(() => applyNetworkAttachmentChange(…)))`.
`orgContext` is in `topology-fixtures.ts:4`.

- [ ] **Step 1: Write the failing tests.**

```ts
it('a new fingerprint creates one unassigned network with its prefix, one gateway and a current membership', async () => {
  // LAPTOP-JS: Ethernet 192.168.1.57/24 via 192.168.1.1 a4:2b:b0:11:22:9c primary.
  // -> learned_networks: 1 row, site_id NULL, prefix '192.168.1.0/24';
  //    gateways: (192.168.1.1, a4:2b:b0:11:22:9c); devices row: Ethernet, 192.168.1.57, is_primary, is_current.
});
it('a known fingerprint reuses its network; a second device adds only a membership', async () => {
  // LAPTOP-JS then DESKTOP-01 (Ethernet 192.168.1.60) via the same fingerprint -> 1 network, 1 gateway, 2 rows.
});
it('T7 both memberships current', async () => {
  // network N seeded with gateways (192.168.1.1, a4:2b:b0:11:22:9c) and (10.1.2.100, 00:1a:8c:00:00:01).
  // LAPTOP-JS reports Ethernet via the first and Wi-Fi 10.1.2.57/24 via the second, complete.
  // -> two rows, both is_current, both under N; learned_networks count unchanged.
});
it('a complete report clears memberships it no longer lists; an incomplete one does not', async () => {
  // applied: Ethernet via F1 and Wi-Fi 10.1.2.57 via (10.1.2.100, 00:1a:8c:00:00:01).
  // next: only Ethernet, complete false -> both rows still is_current.
  // next: only Ethernet, complete true -> Wi-Fi row is_current false, row kept; Ethernet row current.
});
it('null gateway MAC keeps the current membership', async () => {
  // applied: Ethernet 192.168.1.57 via 192.168.1.1 a4:2b:b0:11:22:9c (current).
  // next complete report: the same attachment with gatewayMac null.
  // -> plan.kind 'apply' with deviceFields.networkAttachmentsConfirmedAt = now; after apply the row is
  //    still is_current; learned_networks and learned_network_gateways counts unchanged.
  // A null-MAC attachment on a different interface or address protects nothing: that row is cleared.
});
it('two attachments behind one fingerprint make one row: the primary one wins', async () => {
  // Ethernet 192.168.1.57 (primary false) and Wi-Fi 192.168.1.80 (primary true), both via F1
  // -> one row: interface_name 'Wi-Fi', local_address 192.168.1.80, is_primary true.
});
it('prefix is updated when the observed LAN prefix changes, and not written when equal', async () => {
  // 192.168.1.57/24 then /25 -> prefix '192.168.1.0/25'; updated_at moves only on the change.
});
it('records the WAN address on the primary attachment network and caps it at 32', async () => {
  // wan '203.0.113.20' -> one WAN row on the primary network, none on the other.
  // apply again with the same WAN and a changed attachment -> that row's xmin unchanged (not rewritten).
  // seed 32 rows with older last_seen_at, apply '198.51.100.7' -> 32 rows, the oldest gone, new one present.
});
it('does not create a network beyond the per-org limit', async () => {
  // insert 5,000 networks for the org with generate_series; a new fingerprint -> no network,
  // no gateway, no membership; apply resolves (does not throw).
});
it('concurrent first sightings of one fingerprint create one network', async () => {
  // tx1 (LAPTOP-JS) and tx2 (DESKTOP-01) each in their own system context and transaction.
  // tx1 applies, then waits; tx2 starts its apply; poll pg_locks until one advisory lock is not granted;
  // tx1 commits; both resolve. -> exactly 1 network, 1 gateway, 2 memberships on it.
});
```

- [ ] **Step 2: Run and see them fail.**
  `pnpm test-stack up`, then `pnpm --filter @breeze/api test:integration src/__tests__/integration/learnedNetworksIngest.integration.test.ts`.
  Expected: FAIL, `applyNetworkAttachmentChange is not a function`.
- [ ] **Step 3: Implement** in this order, all statements on `db`:
  1. Group the attachments that have a MAC by `(gatewayMac, gatewayAddress)`. The representative of a
     group is the primary one, else the lowest `interfaceName`.
  2. Read existing gateways for the org and those keys in one statement.
  3. For each missing key, in ascending order: advisory lock (decision 7), re-read, then create. Creating
     checks `count(*)` of the org's networks against `LEARNED_NETWORKS_PER_ORG_MAX` (decision 8), then
     inserts the network (`prefix = network(set_masklen(localAddress::inet, prefixLength))`) and the gateway.
  4. Upsert one membership per resolved gateway, ascending `gateway_id`:
     `ON CONFLICT (device_id, gateway_id) DO UPDATE` sets `interface_name`, `local_address`,
     `is_primary`, `is_current = true` and `last_seen_at`.
  5. If `report.complete`: set `is_current = false` on this device's current rows that were neither
     upserted in step 4 nor protected by a null-MAC attachment (decision 6).
  6. `prefix` per decision 7. Then insert the WAN row with `ON CONFLICT (network_id, address) DO NOTHING`.
     Only when a row was inserted, delete that network's rows beyond the 32 newest by
     `(last_seen_at DESC, id DESC)`. An existing WAN row is never rewritten here; the hourly refresh
     dates it, so a release that makes a whole office apply at once does not queue on one row.
- [ ] **Step 4: Run it.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(api): apply learned network membership changes"`.

---

### Task 4: Heartbeat wiring

**Files:** Modify `apps/api/src/routes/agents/schemas.ts:210`, `routes/agents/heartbeat.ts`,
`routes/metrics.ts`, `routes/agentWs.ts:937`. Test: `routes/agents/schemas.heartbeatTolerance.test.ts`,
new `routes/agentWs.heartbeatSchema.test.ts`, the ingest integration file (describe block
`heartbeat route`), and `agentHotPathQueryBudget.integration.test.ts`.

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces: `recordNetworkAttachmentReport(outcome: 'confirm' | 'apply' | 'apply_failed' | Exclude<IngestIgnoreReason, 'absent'>): void`
  (an absent field is not a report and is not counted) and the counter `breeze_network_attachment_reports_total{outcome}`, defined beside
  `agentControlPlaneBlockReportsTotal` (`routes/metrics.ts:262`, `:897`). `heartbeatMessageSchema` is
  exported from `routes/agentWs.ts`.

Route fixture: copy `enrollDevice`, `agentApp` and the beat helper from
`heartbeatRetainState.integration.test.ts:49-139`, with hostnames `LAPTOP-JS` and `DESKTOP-01`. Add a
hoisted `vi.mock('../../services/clientIp', async (importOriginal) => ({ ...(await importOriginal()), getTrustedClientIpOrUndefined: () => clientIp.value }))`
with a mutable `clientIp.value` (default `'203.0.113.20'`). It spreads the real module because enrollment
uses it too. Read the counter with
`metricsRegistry.getSingleMetric('breeze_network_attachment_reports_total')` (`services/metricsRegistry.ts:37`).

- [ ] **Step 1: Write the failing tests.**

```ts
// schemas.heartbeatTolerance.test.ts
it('passes networkAttachmentsV1 through untouched, even when malformed', () => {
  for (const v of [{ epoch: 'x' }, 'junk', 7]) expect(heartbeatSchema.parse({ ...minimal, networkAttachmentsV1: v }).networkAttachmentsV1).toEqual(v);
});
// agentWs.heartbeatSchema.test.ts (plan call 2)
it('the WebSocket heartbeat does not accept networkAttachmentsV1', () => {
  expect(Object.keys(heartbeatMessageSchema.shape).sort()).toEqual(['ipHistoryUpdate', 'timestamp', 'type']);
  const parsed = heartbeatMessageSchema.parse({ type: 'heartbeat', timestamp: 1, networkAttachmentsV1: { epoch: '9f2c1e7ab4d04c11' } });
  expect('networkAttachmentsV1' in parsed).toBe(false);
});
```

```ts
// learnedNetworksIngest.integration.test.ts, describe('heartbeat route')
it('learns on the first beat and stores the four device columns', async () => {
  // LAPTOP-JS beat with report() -> one network, gateway, row, WAN 203.0.113.20; devices.network_attachment_epoch
  // '9f2c1e7ab4d04c11', sequence 418, digest 64 hex chars, confirmed_at set; counter 'apply' +1.
});
it("unchanged report adds no write beyond the heartbeat's own", async () => {
  // beat 1 (sequence 1) applies. Snapshot S = rows of (table, id, xmin::text, ctid::text) for the org in
  // learned_networks, learned_network_gateways, learned_network_devices, learned_network_wan_addresses.
  // beat 2: same attachments and WAN, sequence 2.
  // -> snapshot equals S exactly (no row inserted, updated or deleted);
  //    device digest unchanged, sequence = 2, confirmed_at advanced; counter outcome 'confirm' +1;
  //    devices.partner_export_updated_at unchanged (the new columns are not partner-export material).
});
it('a beat without the field changes nothing and counts nothing', async () => {
  // beat 1 applies report() (sequence 418). beat 2 carries no networkAttachmentsV1 -> 200; the four
  // devices.network_attachment* columns equal their beat-1 values (confirmed_at not advanced, digest kept);
  // learned rows unchanged (same xmin snapshot as the P8 test); every outcome of the counter unchanged.
});
it('capturedAt outside the bound is ignored and counted', async () => {
  // beat with capturedAt now - 11 min -> 200; no learned rows; the four columns unchanged (null on a
  // fresh device, the previous values after an earlier beat); counter 'capture_time_out_of_bounds' +1.
});
it('a learner failure never fails or rolls back the heartbeat', async () => {
  // failWritesOn('learned_network_devices') (caughtQueryFaults.ts:19) -> beat returns 200; devices.last_seen_at
  // advanced; no learned rows; digest still null; counter 'apply_failed' +1.
  // clearStatementFaults(); next beat (same report, next sequence) applies.
});
it('the watchdog, parked and ephemeral paths learn nothing', async () => {
  // agent context role 'watchdog' with body role 'watchdog'; isPreAssignment true; is_ephemeral = true
  // (admin update). Each with a valid report -> no learned rows and the four columns stay null,
  // whatever the response status.
});
it('the kill switch stops learning and confirmations, and turning it back on resumes', async () => {
  // vi.stubEnv('LEARNED_NETWORKS_INGEST_ENABLED', 'false') -> no rows, confirmed_at unchanged,
  // counter 'disabled' +1; unstub -> next beat applies.
});
it('records the WAN address only for a public client address', async () => {
  // clientIp.value = '192.168.1.20' -> no WAN row; '198.51.100.7' with a changed report -> one row.
});
```

In `agentHotPathQueryBudget.integration.test.ts`, add beside the steady-state case (`:836`):
`a steady-state beat with an unchanged networkAttachmentsV1 report costs the same statements as one without it`.
It enrolls a device and beats once with a report so it applies. Then: `advanceClock(NEXT_BEAT_MS)`; a
sibling beats; `dropDeviceRedisCaches`; it measures a beat with the same report and the next sequence,
and a steady beat without the field the same way. Expect equal `transactions` and `statements`, and no
recorded statement containing `learned_network`.

- [ ] **Step 2: Run and see them fail.**
  `cd apps/api && npx vitest run src/routes/agents/schemas.heartbeatTolerance.test.ts src/routes/agentWs.heartbeatSchema.test.ts`
  (FAIL: the field is stripped; the schema is not exported). Then the ingest and budget integration files
  with `pnpm --filter @breeze/api test:integration <file>` (FAIL: nothing is learned).
- [ ] **Step 3: Implement.** Add `networkAttachmentsV1: z.unknown().optional()` after `networkContextV1`
  (`schemas.ts:210`). Export `heartbeatMessageSchema` without changing it. In `heartbeat.ts`, directly
  after the `planControlPlaneBlockWrite` merge (`:1399-1402`):

```ts
const attachmentsAt = new Date();
const attachmentPlan = planNetworkAttachmentIngest(device, data.networkAttachmentsV1,   // undefined -> ignore 'absent'
  getTrustedClientIpOrUndefined(c) ?? null, attachmentsAt);
if (attachmentPlan.kind === 'apply') {
  try {
    await withDbTransaction(() => applyNetworkAttachmentChange({ id: device.id, orgId: device.orgId }, attachmentPlan, attachmentsAt));
    Object.assign(deviceUpdates, attachmentPlan.deviceFields);   // only after a committed savepoint
    recordNetworkAttachmentReport('apply');
  } catch (err) {
    console.error('[heartbeat] learned network ingest failed', { deviceId: device.id, orgId: device.orgId });
    captureException(err);
    recordNetworkAttachmentReport('apply_failed');               // fields not merged: the next beat retries
  }
} else if (attachmentPlan.kind === 'confirm') {
  Object.assign(deviceUpdates, attachmentPlan.deviceFields);
  recordNetworkAttachmentReport('confirm');
} else if (attachmentPlan.reason !== 'absent') {
  recordNetworkAttachmentReport(attachmentPlan.reason);
}                                                                // 'absent': no change, nothing written or counted
```

  `device` is the row from `selectOwnDeviceRowForUpdate` (`:865`). It is the full row, so it carries
  `isEphemeral` and the four new columns. The parked return (`:700`) and the watchdog return (`:1201`)
  come first, so those paths never reach this block. A `capture_time_out_of_bounds` ignore is also
  logged at warn level with the device id and the skew in seconds (index review focus 5), at most once
  per device per hour. The planner runs on every beat that reaches this
  point; it is pure, so a beat without the field costs no statement (the budget test below pins it).
- [ ] **Step 4: Run** Step 2's commands, plus `cd apps/api && npx vitest run src/__tests__/agentOwnDeviceRowUpdates.contract.test.ts`
  (PASS with no allowlist change, because `ingest.ts` has no `devices` write), and
  `heartbeatRetainState.integration.test.ts` and `caughtQueryAgentPaths.integration.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(api): learn network attachments from the REST heartbeat"`.

---

### Task 5: Last-seen refresh, retention and the maintenance job

**Files:** Create `apps/api/src/services/learnedNetworks/maintenance.ts`,
`apps/api/src/jobs/learnedNetworkMaintenance.ts` and `.test.ts`,
`apps/api/src/__tests__/integration/learnedNetworksMaintenance.integration.test.ts`. Modify
`jobs/scheduleRegistry.ts:78`, `services/workerRegistry.ts` (append before `:2261`),
`services/workerRegistry.test.ts` (append before `:164`), and `__tests__/parkedFanout.contract.test.ts`
(`EXEMPT`, `:224`).

**Interfaces:**
- Produces: E4 exactly. The job module exports `initializeLearnedNetworkMaintenance()` and
  `shutdownLearnedNetworkMaintenance()`, and the queue `learned-network-maintenance`.

- [ ] **Step 1: Write the failing tests.**

```ts
// learnedNetworksMaintenance.integration.test.ts (NOW fixed; DAY = 86_400_000)
it('refresh copies a current row\'s device confirmation into the row, its gateway, network and WAN row', async () => {
  // device confirmed NOW-5m, last_seen_ip '203.0.113.20'; current primary row last seen NOW-3h; WAN row
  // 203.0.113.20 on that network last seen NOW-3h -> all four last_seen_at = NOW-5m;
  // counts { gateways: 1, networks: 1, devices: 1, wan: 1 }. A second run returns all zeros.
});
it('refresh ignores rows that are not current and never moves a timestamp backwards', async () => {
  // row is_current false, device confirmed NOW-5m, row last seen NOW-3h -> unchanged.
  // current row last seen NOW-1m, device confirmed NOW-5m -> unchanged.
});
it('retention deletes unassigned, unignored networks unseen for 90 days with their children', async () => {
  // N1 last seen NOW-91d -> deleted, its gateway, device rows and WAN rows gone.
  // N2 NOW-89d -> kept.
});
it('retention never deletes an assigned, ignored or profile-referenced network', async () => {
  // three networks at NOW-400d: assigned (site gated), ignored, referenced by discovery_profiles.network_id -> all kept.
});
it('retention deletes device rows unseen for 90 days and clears the device digest when the row was current', async () => {
  // row A NOT current, NOW-91d -> deleted, LAPTOP-JS digest untouched.
  // row B current, NOW-91d on DESKTOP-01 -> deleted and DESKTOP-01.network_attachment_digest IS NULL.
  // row C NOW-89d -> kept. Result { networksDeleted: 0, deviceRowsDeleted: 2 }.
});
it('a job or asset pointing at a deleted network keeps its row with the link nulled', async () => {
  // N at NOW-91d referenced by discovery_jobs.network_id and discovered_assets.last_network_id
  // -> N deleted; both rows exist with the link NULL.
});
```

```ts
// jobs/learnedNetworkMaintenance.test.ts (mocks as in jobs/wakeAttemptRetention.test.ts:1-16)
it('registers both schedulers on their registry slots', async () => {
  await initializeLearnedNetworkMaintenance();
  expect(schedule).toHaveBeenCalledWith('learned-network-last-seen', { pattern: jobSchedule('learned-network-last-seen') }, expect.objectContaining({ name: 'refresh-last-seen' }));
  expect(schedule).toHaveBeenCalledWith('learned-network-retention', { pattern: jobSchedule('learned-network-retention') }, expect.objectContaining({ name: 'retention' }));
  expect(attach).toHaveBeenCalledWith(expect.anything(), 'learnedNetworkMaintenance');
});
it('dispatches each job name to its service function and rethrows a failure', async () => {
  // processor({ name: 'refresh-last-seen' }) calls refreshLearnedNetworkLastSeen once with a Date;
  // 'retention' calls runLearnedNetworkRetention; a rejected service promise rejects the processor.
});
```

- [ ] **Step 2: Run and see them fail.** `cd apps/api && npx vitest run src/jobs/learnedNetworkMaintenance.test.ts`
  and the integration file. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement.** `maintenance.ts` runs in `withSystemDbAccessContext`, one transaction per
  batch of 1,000, looping until a batch is short. The refresh's device-row statement is below. The
  gateway, network and WAN statements have the same `due … FOR UPDATE OF … SKIP LOCKED` shape. The
  gateway source is `max(last_seen_at)` of its device rows; the network source is `max` of its gateways.
  The WAN source is `max(d.network_attachments_confirmed_at)` grouped by `(g.network_id, d.last_seen_ip)`
  over current primary rows, matched on `host(w.address) = d.last_seen_ip`. `SKIP LOCKED` keeps the
  batch from waiting on, or deadlocking with, a heartbeat's apply.

```sql
WITH due AS (
  SELECT m.id, d.network_attachments_confirmed_at AS seen
    FROM learned_network_devices m JOIN devices d ON d.id = m.device_id
   WHERE m.is_current AND d.network_attachments_confirmed_at > m.last_seen_at
   ORDER BY m.id LIMIT 1000 FOR UPDATE OF m SKIP LOCKED)
UPDATE learned_network_devices m SET last_seen_at = due.seen FROM due WHERE m.id = due.id;
```

  Retention, with `cutoff = now - 90 days` (`UNASSIGNED_NETWORK_RETENTION_DAYS` and
  `NETWORK_DEVICE_RETENTION_DAYS`). Each batch reads its target ids first. Next comes one
  `UPDATE devices SET network_attachment_digest = NULL` for the devices that lose a current row (devices
  before membership rows: the heartbeat's lock order). Then it deletes by id with the predicate
  re-checked. Device rows: `last_seen_at < cutoff`. Networks: `site_id IS NULL AND ignored_at IS NULL AND
  last_seen_at < cutoff AND NOT EXISTS (SELECT 1 FROM discovery_profiles p WHERE p.network_id = n.id)`.
  Their gateways, device rows and WAN rows cascade, and the digest clear covers devices with current
  rows under them. `deviceRowsDeleted` counts direct deletes only.

  The job copies `jobs/wakeAttemptRetention.ts` (`Queue.upsertJobScheduler`, `attachWorkerObservability`).
  Its worker switches on `job.name` and calls the service with `new Date()`. Registry entries:
  `'learned-network-last-seen': '16 * * * *'` in the sub-daily block and
  `'learned-network-retention': '33 17 * * *'` in the daily block, each with a one-line comment that the
  slot was free. Append `learnedNetworkMaintenance` to `WORKER_REGISTRY` (`placement: 'global'`) and to
  `EXPECTED_WORKER_NAMES` in the same position. Add to `EXEMPT`:
  `'services/learnedNetworks/maintenance.ts': 'derived: refreshes learned-network last-seen times from device confirmations the heartbeat already accepted and applies retention; selects no device to act on'`.
- [ ] **Step 4: Run** Step 2's commands, plus `cd apps/api && npx vitest run src/jobs/scheduleRegistry.contract.test.ts
  src/services/workerRegistry.test.ts src/__tests__/parkedFanout.contract.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(api): learned network last-seen refresh and retention job"`.

---

## Done when

- [ ] `cd packages/shared && npx vitest run src/validators/networkAttachments.test.ts` — PASS.
- [ ] `cd apps/api && npx vitest run src/services/learnedNetworks src/jobs/learnedNetworkMaintenance.test.ts src/routes/agents/schemas.heartbeatTolerance.test.ts src/routes/agentWs.heartbeatSchema.test.ts src/config/validate.test.ts src/config/envReadComposeCoverage.test.ts src/config/envComposeParity.test.ts src/system/connections/envInventory.test.ts src/jobs/scheduleRegistry.contract.test.ts src/services/workerRegistry.test.ts src/__tests__/parkedFanout.contract.test.ts src/__tests__/agentOwnDeviceRowUpdates.contract.test.ts` — all PASS.
- [ ] `pnpm --filter @breeze/api test:integration src/__tests__/integration/<name>.integration.test.ts`
  PASSES for `learnedNetworksIngest`, `learnedNetworksMaintenance`, `agentHotPathQueryBudget`,
  `heartbeatRetainState`, `caughtQueryAgentPaths`, `learnedNetworksTenancy`, `tenantCascade`,
  `tenant-export-policy`.
- [ ] `pnpm --filter @breeze/api test:integration-suite-coverage` and the full `pnpm --filter @breeze/api test` — PASS.
- [ ] `pnpm test-stack down`.
- [ ] PR body: `Closes #<W01b sub-issue>`; "W01b must be deployed before any agent that sends
  `networkAttachmentsV1` is promoted" (sequencing rule 3); the kill switch name and its default; P8 and the
  two measurements that pin it; the review-focus 2 and 5 test names; plan call 2 (REST only) with its test;
  the Contract notes below.

## Contract notes

1. **B1 gains a parse bound.** More than 64 attachments is `invalid_report`; 9 to 64 are cut to 8 as B1
   says. B1 sets no upper bound for parsing.
2. **B1 normalizes non-gateway MAC values to null.** `00:00:00:00:00:00`, `ff:ff:ff:ff:ff:ff`,
   `02:00:00:00:00:00` (the macOS placeholder) and any group-bit (multicast) MAC become `null`, so they
   behave as an absent entry (plan call 6) instead of becoming a fingerprint.
3. **The WAN refresh source is inferred.** No per-device WAN is stored (spec non-goal). The hourly
   refresh dates WAN rows from `devices.last_seen_ip`, which `middleware/agentAuth.ts:880-963` writes from
   `getTrustedClientIp`, the same source the learner uses. A WAN row written from an IPv4-mapped IPv6
   client address will not match a differently formatted `last_seen_ip`, and is dated only by applies.
4. **The cap does not retry.** At 5,000 networks a new fingerprint is skipped and the digest is stored, so
   the device learns that network only when its report next changes.
5. **Retention writes `devices`.** It nulls `network_attachment_digest` for devices that lose a current
   row (W01a Contract note 3). This is a worker write outside the agent path, so the
   `updateOwnDeviceRow` contract does not apply. `maintenance.ts` must never be imported from
   `ingest.ts` or any agent route.
