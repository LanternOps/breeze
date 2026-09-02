/**
 * Real-Postgres coverage for the org-merge engine's SQL (org-lifecycle Wave 2,
 * Task 3). Two complementary suites, both inside deliberately rolled-back
 * transactions so nothing persists:
 *
 * 1. Every statement Phase B issues — advisory lock, `SET CONSTRAINTS ALL
 *    DEFERRED`, the whole registry walk, the post-pass fixups, the warning
 *    queries, the merge record and the terminal-shell stamp — executes against
 *    the live catalog. Compiled-SQL unit tests cannot catch a statement that
 *    parses but references a column Postgres does not have.
 *
 * 2. The six hand-written custom executors, driven with REAL colliding rows.
 *    This is the part unit tests structurally cannot assert: that demoting
 *    beats deleting, that the survivor keeps exactly one primary/default/active
 *    row per partial-unique key, that nothing cascades away, and — the subtlest
 *    one — that unioning a NULL (unrestricted) membership array with a
 *    restricted one stays unrestricted instead of silently narrowing access.
 *
 * The end-to-end merge (fence → executeOrgMerge → erasure handoff) is Task 7's
 * `orgMerge.integration.test.ts`; this file stays at the executor level.
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { getRedis } from '../../services/redis';
import { portalSessions } from '../../routes/portal/helpers';
import {
  CUSTOM_EXECUTORS,
  CUSTOM_RESOLVE_EXECUTORS,
  CUSTOM_WOULD_DROP_COUNTS,
} from '../../services/orgMergeCustomExecutors';
import {
  buildKeepSurvivor,
  buildKeepSurvivorDropCount,
  buildRepoint,
  buildRepointDedupe,
  buildRepointDedupeDropCount,
} from '../../services/orgMergeExecutors';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';
import { fenceLoser, previewOrgMerge, runPostPassFixups, unfenceLoser } from '../../services/orgMerge';
import { topologicalCascadeOrder } from '../../services/tenantCascade';

class Rollback extends Error {}

describe('org merge engine SQL against real Postgres', () => {
  it('runs the whole Phase-B statement set against real Postgres', async () => {
    const P = randomUUID();
    const L = randomUUID();
    const S = randomUUID();
    const suffix = L.slice(0, 8);
    let ran = 0;

    try {
      await withSystemDbAccessContext(async () => {
        await db.execute(sql`
          INSERT INTO partners (id, name, slug) VALUES (${P}::uuid, ${'Smoke MSP'}, ${`smoke-${suffix}`})`);
        await db.execute(sql`
          INSERT INTO organizations (id, partner_id, name, slug, status, currency_code)
          VALUES (${L}::uuid, ${P}::uuid, ${'Loser'}, ${`loser-${suffix}`}, 'active', 'USD'),
                 (${S}::uuid, ${P}::uuid, ${'Survivor'}, ${`survivor-${suffix}`}, 'active', 'USD')`);

        // --- epoch target query ---------------------------------------------
        const epochUsers = (await db.execute(sql`
          SELECT id FROM users WHERE org_id = ${L}::uuid
          UNION
          SELECT user_id AS id FROM organization_users WHERE org_id = ${L}::uuid`)) as unknown as unknown[];
        expect(epochUsers.length).toBe(0);

        // --- advisory lock + deferred constraints ---------------------------
        const locked = [L, S].sort();
        await db.execute(
          sql`SELECT public.breeze_partner_export_lock_orgs_exclusive(ARRAY[${sql.join(
            locked.map((v) => sql`${v}::uuid`),
            sql`, `,
          )}]::uuid[])`,
        );
        await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);

        // --- the full registry walk -----------------------------------------
        const policies = getOrgMergePolicies();
        const order = [...(await topologicalCascadeOrder())].reverse();
        for (const table of order) {
          const policy = policies.get(table);
          if (!policy) throw new Error(`no policy for ${table}`);
          if (policy.kind === 'repoint') {
            await db.execute(buildRepoint(table, L, S));
            await db.execute(
              sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${L}::uuid`,
            );
            ran++;
          } else if (policy.kind === 'keep-survivor') {
            for (const st of buildKeepSurvivor(table, L, S)) await db.execute(st);
            await db.execute(buildKeepSurvivorDropCount(table, L, S));
            ran++;
          } else if (policy.kind === 'repoint-dedupe') {
            for (const st of buildRepointDedupe(table, policy.key, policy.keyWhere, L, S)) {
              await db.execute(st);
            }
            await db.execute(buildRepointDedupeDropCount(table, policy.key, policy.keyWhere, L, S));
            ran++;
          } else if (policy.kind === 'custom') {
            // The resolve half first, when there is one — its SQL (the
            // UPDATE ... FROM ... JOIN child re-homes) is the newest and least
            // exercised statement shape in the engine, so it must execute
            // against the live catalog like everything else here.
            const resolveExec = CUSTOM_RESOLVE_EXECUTORS[table];
            if (resolveExec) {
              const resolveOut = await resolveExec(L, S);
              expect(resolveOut.moved, `${table} (resolve)`).toBe(0);
              expect(resolveOut.dropped, `${table} (resolve)`).toBe(0);
            }
            const exec = CUSTOM_EXECUTORS[table];
            if (!exec) throw new Error(`no custom executor for ${table}`);
            const out = await exec(L, S);
            expect(out.moved, table).toBe(0);
            expect(out.dropped, table).toBe(0);
            const counter = CUSTOM_WOULD_DROP_COUNTS[table];
            if (counter) {
              const rows = (await db.execute(counter(L, S))) as unknown as Array<{ n: number }>;
              expect(Number(rows[0]?.n), table).toBe(0);
            }
            ran++;
          }
        }
        expect(ran).toBeGreaterThan(250);

        // --- post-pass fixups (the real function, not a transcription) --------
        const fixups = await runPostPassFixups(L, S, P);
        expect(fixups).toEqual({ moved: 0, dropped: 0 });

        // --- merge record + terminal shell ------------------------------------
        const event = (await db.execute(sql`
          INSERT INTO org_merge_events (partner_id, loser_org_id, loser_org_name, survivor_org_id, actor_user_id, summary)
          VALUES (${P}::uuid, ${L}::uuid, ${'Loser'}, ${S}::uuid, NULL, ${JSON.stringify({
            tables: {},
            warnings: [],
          })}::jsonb)
          RETURNING id`)) as unknown as Array<{ id: string }>;
        expect(event[0]?.id).toBeTruthy();
        const shell = await db.execute(sql`
          UPDATE organizations SET deleted_at = now(), updated_at = now() WHERE id = ${L}::uuid`);
        expect((shell as unknown as { count: number }).count).toBe(1);

        throw new Rollback('done');
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    expect(ran).toBeGreaterThan(250);
  }, 120_000);

  it('fenceLoser / unfenceLoser round-trip through the real exported functions', async () => {
    // Committed (not rolled back): fenceLoser exits the ambient context via
    // runOutsideDbContext, so it would not see uncommitted rows. The harness
    // truncates organizations CASCADE in beforeEach.
    const P = randomUUID();
    const L = randomUUID();
    const suffix = L.slice(0, 8);
    const prior = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';

    try {
      await withSystemDbAccessContext(async () => {
        await db.execute(sql`INSERT INTO partners (id, name, slug) VALUES (${P}::uuid, 'Fence', ${`fence-${suffix}`})`);
        await db.execute(sql`
          INSERT INTO organizations (id, partner_id, name, slug, status, currency_code)
          VALUES (${L}::uuid, ${P}::uuid, 'Fenced', ${`fenced-${suffix}`}, 'suspended', 'USD')`);
      });

      const candidate = {
        id: L,
        partnerId: P,
        name: 'Fenced',
        type: 'customer',
        status: 'suspended',
        deletedAt: null,
      };

      // A portal user with a LIVE session in BOTH portal_users ingress
      // surfaces: the customer portal and the Office add-in surface
      // (/client-ai). Sweeping only the first would leave the add-in writing
      // ai_messages/ai_sessions under the loser through the whole merge.
      //
      // Each surface is seeded in the backend that is ACTUALLY live here:
      // `PORTAL_USE_REDIS` is false outside production (schemas.ts:57), so the
      // portal uses its in-memory map, while /client-ai is Redis-only and
      // ungated. Seeding portal keys into Redis would have tested nothing.
      const portalUserId = randomUUID();
      const portalToken = `pt-${suffix}`;
      const clientAiToken = `ct-${suffix}`;
      await withSystemDbAccessContext(async () => {
        await db.execute(sql`
          INSERT INTO portal_users (id, org_id, email)
          VALUES (${portalUserId}::uuid, ${L}::uuid, ${`pu-${suffix}@x.test`})`);
      });

      portalSessions.set(portalToken, {
        token: portalToken,
        portalUserId,
        orgId: L,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
      });

      const redis = getRedis();
      expect(redis, 'this test requires the test Redis to be reachable').not.toBeNull();
      await redis!.setex(`clientai:session:${clientAiToken}`, 3600, JSON.stringify({ portalUserId, orgId: L }));
      await redis!.sadd(`clientai:user-sessions:${portalUserId}`, clientAiToken);

      await fenceLoser(candidate);

      // Portal surface swept.
      expect(portalSessions.has(portalToken)).toBe(false);
      // Add-in surface swept — session payload AND its set index.
      expect(await redis!.get(`clientai:session:${clientAiToken}`)).toBeNull();
      expect(await redis!.exists(`clientai:user-sessions:${portalUserId}`)).toBe(0);

      const fenced = (await withSystemDbAccessContext(async () =>
        db.execute(sql`
          SELECT status::text AS s, settings->>'mergePriorStatus' AS prior
            FROM organizations WHERE id = ${L}::uuid`),
      )) as unknown as Array<{ s: string; prior: string | null }>;
      expect(fenced[0]?.s).toBe('merging');
      // The PRIOR status must be preserved verbatim — a merge of a suspended
      // duplicate that unfenced to 'active' would silently un-suspend it.
      expect(fenced[0]?.prior).toBe('suspended');

      // Re-fencing an already-fenced org must lose the CAS, not clobber it.
      await expect(fenceLoser(candidate)).rejects.toThrow(/changed state/i);

      await unfenceLoser(candidate);
      const restored = (await withSystemDbAccessContext(async () =>
        db.execute(sql`
          SELECT status::text AS s, settings ? 'mergePriorStatus' AS still
            FROM organizations WHERE id = ${L}::uuid`),
      )) as unknown as Array<{ s: string; still: boolean }>;
      expect(restored[0]?.s).toBe('suspended');
      expect(restored[0]?.still).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
      else process.env.ORG_MERGE_FENCE_DRAIN_MS = prior;
    }
  }, 120_000);

  it('previewOrgMerge validates the pair, walks the registry read-only, and discloses destruction', async () => {
    const P = randomUUID();
    const L = randomUUID();
    const S = randomUUID();
    const suffix = L.slice(0, 8);

    await withSystemDbAccessContext(async () => {
      await db.execute(sql`INSERT INTO partners (id, name, slug) VALUES (${P}::uuid, 'Prev', ${`prev-${suffix}`})`);
      await db.execute(sql`
        INSERT INTO organizations (id, partner_id, name, slug, status, currency_code)
        VALUES (${L}::uuid, ${P}::uuid, 'PL', ${`pl-${suffix}`}, 'active', 'USD'),
               (${S}::uuid, ${P}::uuid, 'PS', ${`ps-${suffix}`}, 'active', 'USD')`);
    });

    // I3: the pair is validated before a single count runs.
    await expect(previewOrgMerge(randomUUID(), S, P)).rejects.toThrow(/not found/i);
    await expect(previewOrgMerge(L, S, randomUUID())).rejects.toThrow(/requesting partner/i);
    await expect(previewOrgMerge(L, L, P)).rejects.toThrow(/itself/i);

    // Every count statement + both count mirrors execute against the live
    // catalog. Empty orgs, so all counts are 0.
    const preview = await previewOrgMerge(L, S, P);
    expect(preview.verdict).toBe('ok');
    expect(preview.totalMovableRows).toBe(0);
    expect(preview.tables).toEqual([]);
    expect(preview.warnings).toEqual([]);

    // I4: an audit row under the loser must surface as a disclosed
    // destruction, NOT be silently omitted from the plan.
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`
        INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
        VALUES (${L}::uuid, 'system', ${P}::uuid, 'test.event', 'organization', 'success')`);
    });
    const disclosed = await previewOrgMerge(L, S, P);
    const auditRow = disclosed.tables.find((t) => t.table === 'audit_logs');
    expect(auditRow).toBeDefined();
    expect(auditRow?.policy).toBe('leave-for-erasure');
    expect(auditRow?.loserRows).toBe(1);
    // Destroyed rows are reported as would-drop and excluded from "movable".
    expect(auditRow?.wouldDrop).toBe(1);
    expect(disclosed.totalMovableRows).toBe(0);
    expect(disclosed.warnings.join('\n')).toMatch(/PERMANENTLY DESTROYED/);
    expect(disclosed.warnings.join('\n')).toMatch(/audit_logs/);

    // M3: capability revocations are invisible in the `wouldDrop` column by
    // construction — api_keys / enrollment_keys rows all MOVE, they just stop
    // working. A preview that reports only drops therefore reads as "nothing is
    // lost" while the merge is about to take every integration bound to the
    // merged-away org offline, so the counts get their own warnings.
    const keyUser = randomUUID();
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`
        INSERT INTO users (id, email, name, partner_id) VALUES (${keyUser}::uuid, ${`ku-${suffix}@x.test`}, 'KU', ${P}::uuid)`);
      await db.execute(sql`
        INSERT INTO api_keys (org_id, name, key_hash, key_prefix, created_by, status) VALUES
          (${L}::uuid, 'live',    ${`h1-${suffix}`}, 'brz_a', ${keyUser}::uuid, 'active'),
          (${L}::uuid, 'dead',    ${`h2-${suffix}`}, 'brz_b', ${keyUser}::uuid, 'revoked'),
          (${S}::uuid, 'S live',  ${`h3-${suffix}`}, 'brz_c', ${keyUser}::uuid, 'active')`);
      await db.execute(sql`
        INSERT INTO enrollment_keys (org_id, name, key, expires_at) VALUES
          (${L}::uuid, 'open',    ${`k1-${suffix}`}, NULL),
          (${L}::uuid, 'lapsed',  ${`k2-${suffix}`}, now() - interval '1 day'),
          (${S}::uuid, 'S open',  ${`k3-${suffix}`}, NULL)`);
    });

    const withKeys = await previewOrgMerge(L, S, P);
    const keyWarnings = withKeys.warnings.join('\n');
    // Counts must mirror the EXECUTORS' predicates, not the raw row counts: the
    // already-revoked key and the already-lapsed enrollment key are not losses,
    // and the survivor's own credentials are never touched.
    expect(keyWarnings).toContain('will REVOKE 1 live API key');
    expect(keyWarnings).toContain('will EXPIRE 1 still-valid enrollment key');
    // ...and the merge really is reported as moving them, not dropping them.
    expect(withKeys.tables.find((t) => t.table === 'api_keys')).toEqual({
      table: 'api_keys', policy: 'custom', loserRows: 2, wouldDrop: 0,
    });
    expect(withKeys.tables.find((t) => t.table === 'enrollment_keys')).toEqual({
      table: 'enrollment_keys', policy: 'custom', loserRows: 2, wouldDrop: 0,
    });
    expect(withKeys.totalMovableRows).toBeGreaterThan(0); // guards the next assertion from being vacuous
    expect(withKeys.verdict).toBe('ok');

    // #2823: compose threads every variable in as `VAR: ${VAR:-}`, so an UNSET
    // ORG_MERGE_MAX_ROWS reaches the container SET to an empty string. Read with
    // `Number(process.env.X ?? DEFAULT)` that yields a cap of 0 — and a cap of 0
    // makes EVERY merge with a single movable row 422 `too-large`, disabling the
    // feature outright on any self-host that did not set the variable.
    // `getMaxMovableRows` goes through `envInt`, which treats '' as absent.
    const priorCap = process.env.ORG_MERGE_MAX_ROWS;
    try {
      process.env.ORG_MERGE_MAX_ROWS = '';
      expect((await previewOrgMerge(L, S, P)).verdict).toBe('ok');
      // ...and a real override is still honoured.
      process.env.ORG_MERGE_MAX_ROWS = '1';
      expect((await previewOrgMerge(L, S, P)).verdict).toBe('too-large');
    } finally {
      if (priorCap === undefined) delete process.env.ORG_MERGE_MAX_ROWS;
      else process.env.ORG_MERGE_MAX_ROWS = priorCap;
    }
  }, 120_000);

  it('custom executors do the right thing with REAL colliding rows', async () => {
    const P = randomUUID();
    const L = randomUUID();
    const S = randomUUID();
    const U = randomUUID();
    const R = randomUUID();
    const R2 = randomUUID();
    const siteA = randomUUID();
    const siteB = randomUUID();
    const dgA = randomUUID();
    const agentLTriage = randomUUID();
    const agentLPatch = randomUUID();
    const agentSTriage = randomUUID();
    const runL = randomUUID();
    const suffix = L.slice(0, 8);
    let asserted = 0;

    try {
      await withSystemDbAccessContext(async () => {
        await db.execute(sql`INSERT INTO partners (id, name, slug) VALUES (${P}::uuid, 'Smoke', ${`smoke2-${suffix}`})`);
        await db.execute(sql`
          INSERT INTO organizations (id, partner_id, name, slug, status, currency_code)
          VALUES (${L}::uuid, ${P}::uuid, 'L', ${`l2-${suffix}`}, 'active', 'USD'),
                 (${S}::uuid, ${P}::uuid, 'S', ${`s2-${suffix}`}, 'active', 'USD')`);
        await db.execute(sql`
          INSERT INTO users (id, email, name, partner_id) VALUES (${U}::uuid, ${`u-${suffix}@x.test`}, 'U', ${P}::uuid)`);
        await db.execute(sql`
          INSERT INTO roles (id, scope, name, partner_id) VALUES
            (${R}::uuid,  'organization', 'Org Viewer', ${P}::uuid),
            (${R2}::uuid, 'organization', 'Org Admin',  ${P}::uuid)`);

        // contacts: an org-level primary in BOTH orgs (partial unique on org_id
        // WHERE is_primary AND site_id IS NULL) + a non-primary that must move.
        await db.execute(sql`
          INSERT INTO contacts (org_id, name, email, is_primary) VALUES
            (${L}::uuid, 'L primary', 'lp@x.test', true),
            (${L}::uuid, 'L other',   'lo@x.test', false),
            (${S}::uuid, 'S primary', 'sp@x.test', true)`);

        // backup_configs: a default in both orgs.
        await db.execute(sql`
          INSERT INTO backup_configs (org_id, name, type, provider, provider_config, is_default) VALUES
            (${L}::uuid, 'L default', 'file', 'local', '{}'::jsonb, true),
            (${S}::uuid, 'S default', 'file', 'local', '{}'::jsonb, true)`);

        // audit_baselines: (a) an active baseline for the SAME os_type in both
        // (deactivate path), plus an L-only os_type that must stay active; and
        // (b) a baseline whose (name, os_type, profile) already exists under
        // the survivor (rename path, for the pre-squash droplet index).
        await db.execute(sql`
          INSERT INTO audit_baselines (org_id, name, os_type, profile, settings, is_active) VALUES
            (${L}::uuid, 'L win', 'windows', 'std', '{}'::jsonb, true),
            (${L}::uuid, 'L mac', 'macos',   'std', '{}'::jsonb, true),
            (${L}::uuid, 'Shared', 'linux',  'cis', '{}'::jsonb, false),
            (${S}::uuid, 'S win', 'windows', 'std', '{}'::jsonb, true),
            (${S}::uuid, 'Shared', 'linux',  'cis', '{}'::jsonb, false)`);

        // fleet_findings: a live episode with the same semantic key in both,
        // plus an L-only live episode that must stay live.
        await db.execute(sql`
          INSERT INTO fleet_findings (org_id, kind, semantic_key, algorithm_version, status, severity, title, first_seen_at, last_seen_at) VALUES
            (${L}::uuid, 'log_correlation', 'k1', 1, 'open', 'warning', 'L k1', now(), now()),
            (${L}::uuid, 'log_correlation', 'k2', 1, 'open', 'warning', 'L k2', now(), now()),
            (${S}::uuid, 'log_correlation', 'k1', 1, 'open', 'warning', 'S k1', now(), now())`);

        // organization_users: the SAME user in both orgs but with DIFFERENT
        // roles and different site grants. Keying on (user_id, role_id) would
        // leave both rows under the survivor and make the resolved role
        // nondeterministic; keying on user_id alone must keep the survivor's
        // role, union the grants, and report the discarded role.
        await db.execute(sql`
          INSERT INTO organization_users (org_id, user_id, role_id, site_ids, device_group_ids) VALUES
            (${L}::uuid, ${U}::uuid, ${R2}::uuid, ARRAY[${siteA}::uuid], ARRAY[${dgA}::uuid]),
            (${S}::uuid, ${U}::uuid, ${R}::uuid,  ARRAY[${siteB}::uuid], NULL)`);

        // api_keys / enrollment_keys: one live credential in EACH org. Only
        // the loser's may be revoked — revoking the survivor's would take the
        // surviving org's integrations down.
        await db.execute(sql`
          INSERT INTO api_keys (org_id, name, key_hash, key_prefix, created_by, status) VALUES
            (${L}::uuid, 'L key', ${`lh-${suffix}`}, 'brz_l', ${U}::uuid, 'active'),
            (${S}::uuid, 'S key', ${`sh-${suffix}`}, 'brz_s', ${U}::uuid, 'active')`);
        await db.execute(sql`
          INSERT INTO enrollment_keys (org_id, name, key, expires_at) VALUES
            (${L}::uuid, 'L enroll', ${`lk-${suffix}`}, NULL),
            (${S}::uuid, 'S enroll', ${`sk-${suffix}`}, NULL)`);

        // ai_agents: an ACTIVE agent of the same `kind` in both orgs (the
        // ai_agents_org_kind_uq collision), plus an L-only kind that must stay
        // active. The loser's triage agent also owns an ai_agent_runs row —
        // that table is `leave-for-erasure` (its org_id is trigger-immutable),
        // and its agent_id FK is ON DELETE RESTRICT, so this row is exactly
        // what makes a dedupe DELETE impossible and the disable path necessary.
        //
        // Task 17 (A2-7, #4192): BOTH loser agents carry graduated
        // `act_assets.supervisedActionKeys`. `agentLTriage` collides and gets
        // disabled by the merge in the same call — it must STILL lose its
        // keys (that's the whole point of not scoping the clear-keys UPDATE
        // to `disabled_at IS NULL`). `agentLPatch` is never disabled and
        // exercises the plain non-zero-row clear path.
        await db.execute(sql`
          INSERT INTO ai_agents (id, org_id, kind, name, created_by, enabled, mode, act_assets) VALUES
            (${agentLTriage}::uuid, ${L}::uuid, 'triage',   'L triage', ${U}::uuid, true, 'act', '{"supervisedActionKeys":["manage_services:restart","x:y"]}'::jsonb),
            (${agentLPatch}::uuid,  ${L}::uuid, 'patch',    'L patch',  ${U}::uuid, true, 'act', '{"supervisedActionKeys":["patch:apply"]}'::jsonb),
            (${agentSTriage}::uuid, ${S}::uuid, 'triage',   'S triage', ${U}::uuid, true, 'act', '{}'::jsonb)`);
        await db.execute(sql`
          INSERT INTO ai_agent_runs (id, agent_id, org_id, trigger_kind, dedupe_key, mode_at_start, policy_snapshot)
          VALUES (${runL}::uuid, ${agentLTriage}::uuid, ${L}::uuid, 'manual', ${`dk-${suffix}`}, 'act', '{}'::jsonb)`);

        await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);

        // --- contacts --------------------------------------------------------
        const contacts = await CUSTOM_EXECUTORS.contacts!(L, S);
        expect(contacts.moved).toBe(2);
        expect(contacts.dropped).toBe(0);
        expect(contacts.notes.join()).toMatch(/demoted 1 primary contact/);
        const primaries = (await db.execute(sql`
          SELECT count(*)::int AS n FROM contacts WHERE org_id = ${S}::uuid AND is_primary AND site_id IS NULL`)) as unknown as Array<{ n: number }>;
        expect(Number(primaries[0]?.n)).toBe(1);
        asserted++;

        // --- backup_configs ---------------------------------------------------
        const backups = await CUSTOM_EXECUTORS.backup_configs!(L, S);
        expect(backups.moved).toBe(1);
        expect(backups.dropped).toBe(0);
        const kept = (await db.execute(sql`
          SELECT count(*)::int AS total, count(*) FILTER (WHERE is_default)::int AS defaults
            FROM backup_configs WHERE org_id = ${S}::uuid`)) as unknown as Array<{ total: number; defaults: number }>;
        expect(Number(kept[0]?.total)).toBe(2); // NEVER deleted
        expect(Number(kept[0]?.defaults)).toBe(1);
        asserted++;

        // --- audit_baselines ---------------------------------------------------
        const baselines = await CUSTOM_EXECUTORS.audit_baselines!(L, S);
        expect(baselines.moved).toBe(3);
        expect(baselines.dropped).toBe(0);
        expect(baselines.notes.join('\n')).toMatch(/deactivated 1 baseline/);
        expect(baselines.notes.join('\n')).toMatch(/renamed 1 baseline/);
        const actives = (await db.execute(sql`
          SELECT os_type, count(*) FILTER (WHERE is_active)::int AS n
            FROM audit_baselines WHERE org_id = ${S}::uuid GROUP BY 1 ORDER BY 1`)) as unknown as Array<{
          os_type: string;
          n: number;
        }>;
        expect(actives.map((r) => [r.os_type, Number(r.n)])).toEqual([
          ['linux', 0], ['macos', 1], ['windows', 1],
        ]);
        // The (name, os_type, profile) collision must be resolved by RENAME —
        // both rows survive under the survivor with distinct names, so the
        // pre-squash droplet index would accept them.
        const shared = (await db.execute(sql`
          SELECT name FROM audit_baselines
           WHERE org_id = ${S}::uuid AND os_type = 'linux' AND profile = 'cis' ORDER BY name`)) as unknown as Array<{
          name: string;
        }>;
        expect(shared).toHaveLength(2);
        expect(shared.map((r) => r.name)).toEqual(['Shared', `Shared (merged ${L.slice(0, 8)})`]);
        asserted++;

        // --- fleet_findings -----------------------------------------------------
        const findings = await CUSTOM_EXECUTORS.fleet_findings!(L, S);
        expect(findings.moved).toBe(2);
        expect(findings.dropped).toBe(0);
        const live = (await db.execute(sql`
          SELECT count(*)::int AS total, count(*) FILTER (WHERE resolved_at IS NULL)::int AS unresolved
            FROM fleet_findings WHERE org_id = ${S}::uuid`)) as unknown as Array<{ total: number; unresolved: number }>;
        expect(Number(live[0]?.total)).toBe(3); // NEVER deleted
        expect(Number(live[0]?.unresolved)).toBe(2); // k1 (survivor's) + k2 (L-only)
        asserted++;

        // --- ai_agents ----------------------------------------------------------
        const agents = await CUSTOM_EXECUTORS.ai_agents!(L, S);
        expect(agents.moved).toBe(2); // both loser agents move; NEITHER is deleted
        expect(agents.dropped).toBe(0);
        expect(agents.notes.join('\n')).toMatch(/disabled 1 agent/);
        // Both loser agents carried graduated keys (one of them on the agent
        // this SAME call just disabled) — the note must report 2, and it must
        // be reported even though one of the two rows is disabled.
        expect(agents.notes.join('\n')).toMatch(
          /cleared graduated supervised action keys on 2 agent\(s\) from the merged-away org — a survivor org must re-earn them \(evidence is leave-for-erasure\)/,
        );
        const clearedKeyRows = (await db.execute(sql`
          SELECT id, act_assets -> 'supervisedActionKeys' AS keys
            FROM ai_agents WHERE id IN (${agentLTriage}::uuid, ${agentLPatch}::uuid) ORDER BY id`)) as unknown as Array<{
          id: string; keys: unknown;
        }>;
        // Real-Postgres proof of the non-zero-row path: both rows — the
        // disabled one AND the active one — now read an empty array, not
        // just a non-zero row count from the mock.
        for (const row of clearedKeyRows) {
          expect(row.keys).toEqual([]);
        }
        const agentRows = (await db.execute(sql`
          SELECT kind, count(*)::int AS total, count(*) FILTER (WHERE disabled_at IS NULL)::int AS active
            FROM ai_agents WHERE org_id = ${S}::uuid GROUP BY 1 ORDER BY 1`)) as unknown as Array<{
          kind: string; total: number; active: number;
        }>;
        // patch: L-only, still active. triage: both rows present, but only the
        // SURVIVOR's stays active — one active per kind is what the partial
        // unique index allows, and dropping to zero would silently disable the
        // survivor's own agent.
        expect(agentRows.map((r) => [r.kind, Number(r.total), Number(r.active)])).toEqual([
          ['patch', 1, 1], ['triage', 2, 1],
        ]);
        const survivingTriage = (await db.execute(sql`
          SELECT id FROM ai_agents WHERE org_id = ${S}::uuid AND kind = 'triage' AND disabled_at IS NULL`)) as unknown as Array<{ id: string }>;
        expect(survivingTriage.map((r) => r.id)).toEqual([agentSTriage]);
        // The merge-disabled row must carry the same shape agentService.disableAgent
        // writes, or a reader that gates on `enabled` would still treat it as live.
        const disabledRow = (await db.execute(sql`
          SELECT enabled, (disabled_at IS NOT NULL) AS is_disabled
            FROM ai_agents WHERE id = ${agentLTriage}::uuid`)) as unknown as Array<{ enabled: boolean; is_disabled: boolean }>;
        expect(disabledRow[0]).toMatchObject({ enabled: false, is_disabled: true });
        // The RESTRICT child survived untouched, and stayed with the LOSER —
        // ai_agent_runs is leave-for-erasure, so the merge must not move it.
        const runRow = (await db.execute(sql`
          SELECT org_id FROM ai_agent_runs WHERE id = ${runL}::uuid`)) as unknown as Array<{ org_id: string }>;
        expect(runRow.map((r) => r.org_id)).toEqual([L]);
        asserted++;

        // --- organization_users --------------------------------------------------
        const members = await CUSTOM_EXECUTORS.organization_users!(L, S);
        expect(members.moved).toBe(0); // the only loser row had a counterpart
        expect(members.dropped).toBe(1);
        const membership = (await db.execute(sql`
          SELECT role_id, site_ids, device_group_ids FROM organization_users WHERE org_id = ${S}::uuid`)) as unknown as Array<{
          role_id: string;
          site_ids: string[] | null;
          device_group_ids: string[] | null;
        }>;
        // Exactly ONE membership row for the user — the whole point of keying
        // on user_id. Two rows would make resolveOrgAxis's ORDER BY-less
        // .limit(1) pick a role at random.
        expect(membership).toHaveLength(1);
        // The SURVIVOR's role wins; the loser's is discarded.
        expect(membership[0]?.role_id).toBe(R);
        expect([...(membership[0]?.site_ids ?? [])].sort()).toEqual([siteA, siteB].sort());
        // The survivor's device_group_ids was NULL == unrestricted, so the
        // union must stay unrestricted rather than narrowing to the loser's list.
        expect(membership[0]?.device_group_ids).toBeNull();
        // The discarded role is named, with both role names, so an admin can re-grant.
        const conflictNote = members.notes.find((n) => n.includes('role conflict'));
        expect(conflictNote).toBeDefined();
        expect(conflictNote).toMatch(/Org Admin/);
        expect(conflictNote).toMatch(/Org Viewer/);
        expect(conflictNote).toMatch(new RegExp(`u-${suffix}@x\\.test`));
        asserted++;

        // --- api_keys / enrollment_keys (revoke, do NOT transfer) ---------------
        const apiKeys = await CUSTOM_EXECUTORS.api_keys!(L, S);
        expect(apiKeys.moved).toBe(1);
        expect(apiKeys.dropped).toBe(0);
        expect(apiKeys.notes.join('\n')).toMatch(/revoked 1 API key/);
        const keyStates = (await db.execute(sql`
          SELECT name, status::text AS status FROM api_keys WHERE org_id = ${S}::uuid ORDER BY name`)) as unknown as Array<{
          name: string;
          status: string;
        }>;
        // The loser's key is revoked; the SURVIVOR's own key is untouched —
        // revoking after the repoint would have killed both.
        expect(keyStates).toEqual([
          { name: 'L key', status: 'revoked' },
          { name: 'S key', status: 'active' },
        ]);
        asserted++;

        const enrollKeys = await CUSTOM_EXECUTORS.enrollment_keys!(L, S);
        expect(enrollKeys.moved).toBe(1);
        expect(enrollKeys.dropped).toBe(0);
        expect(enrollKeys.notes.join('\n')).toMatch(/expired 1 enrollment key/);
        const enrollStates = (await db.execute(sql`
          SELECT name, (expires_at IS NOT NULL AND expires_at <= now()) AS expired
            FROM enrollment_keys WHERE org_id = ${S}::uuid ORDER BY name`)) as unknown as Array<{
          name: string;
          expired: boolean;
        }>;
        expect(enrollStates).toEqual([
          { name: 'L enroll', expired: true },
          { name: 'S enroll', expired: false },
        ]);
        asserted++;

        // --- pax8_orders ----------------------------------------------------
        const integration = randomUUID();
        await db.execute(sql`
          INSERT INTO pax8_integrations (id, partner_id, name, client_id_encrypted, client_secret_encrypted, token_url)
          VALUES (${integration}::uuid, ${P}::uuid, 'Pax8', 'x', 'y', 'https://t.test')`);
        await db.execute(sql`
          INSERT INTO pax8_orders (integration_id, partner_id, org_id, status, source, dedupe_key) VALUES
            (${integration}::uuid, ${P}::uuid, ${L}::uuid, 'draft', 'direct', ${`d-l-${suffix}`}),
            (${integration}::uuid, ${P}::uuid, ${L}::uuid, 'draft', 'quote',  ${`d-lq-${suffix}`}),
            (${integration}::uuid, ${P}::uuid, ${S}::uuid, 'draft', 'direct', ${`d-s-${suffix}`})`);
        const pax8 = await CUSTOM_EXECUTORS.pax8_orders!(L, S);
        expect(pax8.dropped).toBe(1); // the colliding direct draft
        expect(pax8.moved).toBe(1); // the quote-sourced one, outside the index
        expect(pax8.notes.join()).toMatch(/discarded 1 unsubmitted direct draft/);
        const pax8Left = (await db.execute(sql`
          SELECT count(*)::int AS n FROM pax8_orders WHERE org_id = ${S}::uuid`)) as unknown as Array<{ n: number }>;
        expect(Number(pax8Left[0]?.n)).toBe(2);
        asserted++;

        // No loser rows left anywhere the custom executors touched.
        for (const table of ['contacts', 'backup_configs', 'audit_baselines', 'fleet_findings', 'ai_agents', 'organization_users', 'pax8_orders', 'api_keys', 'enrollment_keys']) {
          const left = (await db.execute(
            sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${L}::uuid`,
          )) as unknown as Array<{ n: number }>;
          expect(Number(left[0]?.n), table).toBe(0);
        }

        throw new Rollback('done');
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    expect(asserted).toBe(9);
  }, 120_000);

  /**
   * The five re-home-then-delete executors plus `incidents`, each driven with a
   * colliding loser row that HAS the child the old `repoint-dedupe` DELETE
   * would have tripped over. `reports` (P2-3, #4190) is the one that was never
   * a `repoint-dedupe` at all — it was a plain `repoint` that a new partial
   * unique index turned into a 23505.
   *
   * Every one of these fixtures raises 23503 (or, for `incidents`, silently
   * destroys a case file) under the previous classification — that is the whole
   * point of seeding the child. A version of this test without the child rows
   * would pass against the broken code, so the child is not decoration.
   */
  it('re-homes NO ACTION / RESTRICT children before deleting a colliding duplicate', async () => {
    const P = randomUUID();
    const L = randomUUID();
    const S = randomUUID();
    const suffix = L.slice(0, 8);
    const ids = {
      assetL: randomUUID(), assetS: randomUUID(), assetOnlyL: randomUUID(),
      snmpL: randomUUID(), monitorL: randomUUID(),
      catalog: randomUUID(), installL: randomUUID(), installS: randomUUID(), logL: randomUUID(),
      playbookL: randomUUID(), playbookS: randomUUID(), execL: randomUUID(),
      signerL: randomUUID(), signerS: randomUUID(), ruleL: randomUUID(),
      incidentL: randomUUID(), incidentS: randomUUID(), incidentActionL: randomUUID(),
      siteL: randomUUID(), siteS: randomUUID(), deviceL: randomUUID(),
      userP: randomUUID(), agentP: randomUUID(), scheduleP: randomUUID(),
      reportL: randomUUID(), reportS: randomUUID(),
      reportPlainL: randomUUID(), reportPlainS: randomUUID(),
      runL: randomUUID(), runS: randomUUID(), agentRunL: randomUUID(),
    };
    let asserted = 0;

    try {
      await withSystemDbAccessContext(async () => {
        await db.execute(sql`INSERT INTO partners (id, name, slug) VALUES (${P}::uuid, 'Rehome', ${`rehome-${suffix}`})`);
        await db.execute(sql`
          INSERT INTO organizations (id, partner_id, name, slug, status, currency_code)
          VALUES (${L}::uuid, ${P}::uuid, 'L', ${`rl-${suffix}`}, 'active', 'USD'),
                 (${S}::uuid, ${P}::uuid, 'S', ${`rs-${suffix}`}, 'active', 'USD')`);
        await db.execute(sql`
          INSERT INTO sites (id, org_id, name) VALUES
            (${ids.siteL}::uuid, ${L}::uuid, 'L site'),
            (${ids.siteS}::uuid, ${S}::uuid, 'S site')`);
        await db.execute(sql`
          INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
          VALUES (${ids.deviceL}::uuid, ${L}::uuid, ${ids.siteL}::uuid, ${`ag-${suffix}`}, ${`h-${suffix}`}, 'windows', '11', 'x64', '1.0.0')`);

        await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);

        // --- discovered_assets (resolve half) --------------------------------
        // Colliding IP in both orgs, and the loser's asset carries BOTH an
        // snmp_devices and a network_monitors child on NO ACTION FKs.
        await db.execute(sql`
          INSERT INTO discovered_assets (id, org_id, site_id, ip_address) VALUES
            (${ids.assetL}::uuid,     ${L}::uuid, ${ids.siteL}::uuid, '10.9.0.1'),
            (${ids.assetOnlyL}::uuid, ${L}::uuid, ${ids.siteL}::uuid, '10.9.0.2'),
            (${ids.assetS}::uuid,     ${S}::uuid, ${ids.siteS}::uuid, '10.9.0.1')`);
        await db.execute(sql`
          INSERT INTO snmp_devices (id, org_id, asset_id, name, ip_address, snmp_version)
          VALUES (${ids.snmpL}::uuid, ${L}::uuid, ${ids.assetL}::uuid, 'L snmp', '10.9.0.1', '2c')`);
        await db.execute(sql`
          INSERT INTO network_monitors (id, org_id, asset_id, name, target, monitor_type)
          VALUES (${ids.monitorL}::uuid, ${L}::uuid, ${ids.assetL}::uuid, 'L mon', '10.9.0.1', 'icmp_ping')`);

        const assets = await CUSTOM_RESOLVE_EXECUTORS.discovered_assets!(L, S);
        expect(assets.dropped).toBe(1);
        expect(assets.moved).toBe(0);
        expect(assets.notes.join('\n')).toMatch(/re-homed its monitoring children/);
        expect(assets.notes.join('\n')).toMatch(/snmp_devices: 1/);
        expect(assets.notes.join('\n')).toMatch(/network_monitors: 1/);
        // Both children now point at the SURVIVOR's asset, by id — a count
        // would pass even if they had been orphaned onto the wrong row.
        const rehomedChildren = (await db.execute(sql`
          SELECT 'snmp' AS kind, asset_id FROM snmp_devices WHERE id = ${ids.snmpL}::uuid
          UNION ALL
          SELECT 'mon',           asset_id FROM network_monitors WHERE id = ${ids.monitorL}::uuid`)) as unknown as Array<{
          kind: string; asset_id: string;
        }>;
        expect(rehomedChildren.map((r) => r.asset_id)).toEqual([ids.assetS, ids.assetS]);
        // The non-colliding loser asset is untouched by the resolve half — it
        // is the `move` half's job, and only after `sites` has moved.
        //
        // That MOVE half is deliberately NOT invoked here: it is a plain
        // `buildRepoint`, and calling it out of walk order raises 23503 from
        // `breeze_partner_export_site_child_update` ("site child tenant owner
        // does not match site") because the asset's `site_id` still points at a
        // loser-owned site. Parents-first ordering is what makes it legal, so
        // it is proven where that ordering exists: the Phase-B walk test above
        // and the Task-7 gauntlet.
        const survivingLoserAssets = (await db.execute(sql`
          SELECT id FROM discovered_assets WHERE org_id = ${L}::uuid ORDER BY ip_address`)) as unknown as Array<{
          id: string;
        }>;
        expect(survivingLoserAssets.map((r) => r.id)).toEqual([ids.assetOnlyL]);
        asserted++;

        // --- plugin_installations --------------------------------------------
        await db.execute(sql`
          INSERT INTO plugin_catalog (id, slug, name, version, type)
          VALUES (${ids.catalog}::uuid, ${`slug-${suffix}`}, 'P', '1.0.0', 'integration')`);
        await db.execute(sql`
          INSERT INTO plugin_installations (id, org_id, catalog_id, version) VALUES
            (${ids.installL}::uuid, ${L}::uuid, ${ids.catalog}::uuid, '1.0.0'),
            (${ids.installS}::uuid, ${S}::uuid, ${ids.catalog}::uuid, '1.0.0')`);
        await db.execute(sql`
          INSERT INTO plugin_logs (id, installation_id, level, message)
          VALUES (${ids.logL}::uuid, ${ids.installL}::uuid, 'info', 'hello')`);

        const plugins = await CUSTOM_EXECUTORS.plugin_installations!(L, S);
        expect(plugins.dropped).toBe(1);
        expect(plugins.moved).toBe(0);
        expect(plugins.notes.join('\n')).toMatch(/plugin_logs: 1/);
        const logRow = (await db.execute(sql`
          SELECT installation_id FROM plugin_logs WHERE id = ${ids.logL}::uuid`)) as unknown as Array<{
          installation_id: string;
        }>;
        expect(logRow[0]?.installation_id).toBe(ids.installS);
        asserted++;

        // --- playbook_definitions ---------------------------------------------
        // Same name in both orgs, differing only by case — the unique index is
        // on lower(name), so the executor's key has to match on lower() too.
        await db.execute(sql`
          INSERT INTO playbook_definitions (id, org_id, name, description, steps) VALUES
            (${ids.playbookL}::uuid, ${L}::uuid, ${`Restart ${suffix}`}, 'l', '[]'::jsonb),
            (${ids.playbookS}::uuid, ${S}::uuid, ${`RESTART ${suffix}`}, 's', '[]'::jsonb)`);
        await db.execute(sql`
          INSERT INTO playbook_executions (id, org_id, device_id, playbook_id, triggered_by)
          VALUES (${ids.execL}::uuid, ${L}::uuid, ${ids.deviceL}::uuid, ${ids.playbookL}::uuid, 'manual')`);

        const playbooks = await CUSTOM_EXECUTORS.playbook_definitions!(L, S);
        expect(playbooks.dropped).toBe(1);
        expect(playbooks.notes.join('\n')).toMatch(/playbook_executions: 1/);
        const execRow = (await db.execute(sql`
          SELECT playbook_id FROM playbook_executions WHERE id = ${ids.execL}::uuid`)) as unknown as Array<{
          playbook_id: string;
        }>;
        expect(execRow[0]?.playbook_id).toBe(ids.playbookS);
        asserted++;

        // --- pam_signer_groups (ON DELETE RESTRICT, not NO ACTION) -------------
        await db.execute(sql`
          INSERT INTO pam_signer_groups (id, org_id, name) VALUES
            (${ids.signerL}::uuid, ${L}::uuid, ${`Vendor ${suffix}`}),
            (${ids.signerS}::uuid, ${S}::uuid, ${`Vendor ${suffix}`})`);
        await db.execute(sql`
          INSERT INTO pam_rules (id, org_id, name, verdict, match_signer_group_id)
          VALUES (${ids.ruleL}::uuid, ${L}::uuid, 'L rule', 'auto_approve', ${ids.signerL}::uuid)`);

        const signers = await CUSTOM_EXECUTORS.pam_signer_groups!(L, S);
        expect(signers.dropped).toBe(1);
        expect(signers.notes.join('\n')).toMatch(/pam_rules: 1/);
        const ruleRow = (await db.execute(sql`
          SELECT match_signer_group_id AS g FROM pam_rules WHERE id = ${ids.ruleL}::uuid`)) as unknown as Array<{
          g: string;
        }>;
        expect(ruleRow[0]?.g).toBe(ids.signerS);
        asserted++;

        // --- incidents (neutralize, NEVER delete) ------------------------------
        await db.execute(sql`
          INSERT INTO incidents (id, org_id, title, classification, severity, detected_at, source_type, source_ref) VALUES
            (${ids.incidentL}::uuid, ${L}::uuid, 'L dup', 'security', 'p2', now(), 'alert', ${`ref-${suffix}`}),
            (${ids.incidentS}::uuid, ${S}::uuid, 'S dup', 'security', 'p2', now(), 'alert', ${`ref-${suffix}`})`);
        await db.execute(sql`
          INSERT INTO incident_actions (id, org_id, incident_id, action_type, description, executed_at)
          VALUES (${ids.incidentActionL}::uuid, ${L}::uuid, ${ids.incidentL}::uuid, 'isolate', 'isolated host', now())`);

        const incidents = await CUSTOM_EXECUTORS.incidents!(L, S);
        expect(incidents.dropped).toBe(0); // NEVER deleted
        expect(incidents.moved).toBe(1);
        expect(incidents.notes.join('\n')).toMatch(/cleared the source reference on 1 incident/);
        const incidentRow = (await db.execute(sql`
          SELECT org_id, source_ref, summary FROM incidents WHERE id = ${ids.incidentL}::uuid`)) as unknown as Array<{
          org_id: string; source_ref: string | null; summary: string | null;
        }>;
        expect(incidentRow[0]?.org_id).toBe(S);
        // Out of the partial index, but the old reference is recoverable.
        expect(incidentRow[0]?.source_ref).toBeNull();
        expect(incidentRow[0]?.summary).toContain(`alert:ref-${suffix}`);
        // The child that a DELETE would have tripped over is still attached.
        const actionRow = (await db.execute(sql`
          SELECT incident_id FROM incident_actions WHERE id = ${ids.incidentActionL}::uuid`)) as unknown as Array<{
          incident_id: string;
        }>;
        expect(actionRow[0]?.incident_id).toBe(ids.incidentL);
        // And the survivor kept its OWN source_ref — clearing that instead
        // would break its de-dup hook and leave the loser's in the index.
        const survivorIncident = (await db.execute(sql`
          SELECT source_ref FROM incidents WHERE id = ${ids.incidentS}::uuid`)) as unknown as Array<{
          source_ref: string | null;
        }>;
        expect(survivorIncident[0]?.source_ref).toBe(`ref-${suffix}`);
        asserted++;

        // --- reports (P2-3 narrative definitions, #4190) ----------------------
        // A PARTNER-WIDE narrative schedule mints one system-managed definition
        // per org, so both orgs hold a row for the SAME schedule id. Under the
        // old `repoint` classification this fixture raises 23505 on
        // reports_source_ai_agent_schedule_uniq and aborts the merge; under a
        // `repoint-dedupe` it would raise 23503 on report_runs.report_id
        // instead. Both loser report_runs below exist precisely so a version of
        // this test that dropped them would fail.
        await db.execute(sql`
          INSERT INTO users (id, partner_id, email, name)
          VALUES (${ids.userP}::uuid, ${P}::uuid, ${`rehome-${suffix}@example.com`}, 'Rehome')`);
        await db.execute(sql`
          INSERT INTO ai_agents (id, org_id, partner_id, kind, name, created_by)
          VALUES (${ids.agentP}::uuid, NULL, ${P}::uuid, 'triage', 'Triage', ${ids.userP}::uuid)`);
        await db.execute(sql`
          INSERT INTO ai_agent_schedules (id, org_id, partner_id, agent_id, kind, cron, sweep_kinds)
          VALUES (${ids.scheduleP}::uuid, NULL, ${P}::uuid, ${ids.agentP}::uuid, 'narrative', '0 6 * * 1', '{}')`);
        await db.execute(sql`
          INSERT INTO reports (id, org_id, name, type, source_ai_agent_schedule_id) VALUES
            (${ids.reportL}::uuid, ${L}::uuid, 'Weekly narrative', 'ai_org_narrative', ${ids.scheduleP}::uuid),
            (${ids.reportS}::uuid, ${S}::uuid, 'Weekly narrative', 'ai_org_narrative', ${ids.scheduleP}::uuid),
            -- Ordinary reports in BOTH orgs: NULL keys must NOT be treated as a
            -- collision -- the partial index and the executor's plain equality
            -- are both NULL-blind. If they were, this pair would drop too.
            (${ids.reportPlainL}::uuid, ${L}::uuid, 'Inventory', 'device_inventory', NULL),
            (${ids.reportPlainS}::uuid, ${S}::uuid, 'Inventory', 'device_inventory', NULL)`);
        await db.execute(sql`
          INSERT INTO report_runs (id, report_id, status) VALUES
            (${ids.runL}::uuid, ${ids.reportL}::uuid, 'completed'),
            (${ids.runS}::uuid, ${ids.reportS}::uuid, 'completed')`);
        await db.execute(sql`
          INSERT INTO ai_agent_runs (id, agent_id, org_id, trigger_kind, dedupe_key, mode_at_start, policy_snapshot, profile, report_run_id)
          VALUES (${ids.agentRunL}::uuid, ${ids.agentP}::uuid, ${L}::uuid, 'schedule', ${`narr-${suffix}`}, 'shadow', '{}'::jsonb, 'narrative', ${ids.runL}::uuid)`);

        const reportsOut = await CUSTOM_EXECUTORS.reports!(L, S);
        // Exactly ONE definition dropped (the narrative duplicate) — never the
        // ordinary report, whose key is NULL.
        expect(reportsOut.dropped).toBe(1);
        expect(reportsOut.moved).toBe(1);
        expect(reportsOut.notes.join('\n')).toMatch(/re-homed its generated reports/);
        expect(reportsOut.notes.join('\n')).toMatch(/report_runs: 1/);
        // The loser's generated artifact survives, re-homed by id onto the
        // survivor's definition — a count alone would pass on an orphan.
        const runRow = (await db.execute(sql`
          SELECT report_id FROM report_runs WHERE id = ${ids.runL}::uuid`)) as unknown as Array<{
          report_id: string;
        }>;
        expect(runRow[0]?.report_id).toBe(ids.reportS);
        // BOTH runs are now reachable under the one surviving definition.
        const survivingRuns = (await db.execute(sql`
          SELECT r.id FROM report_runs r
            JOIN reports p ON p.id = r.report_id
           WHERE p.org_id = ${S}::uuid AND p.source_ai_agent_schedule_id = ${ids.scheduleP}::uuid
           ORDER BY r.id`)) as unknown as Array<{ id: string }>;
        expect(survivingRuns.map((r) => r.id).sort()).toEqual([ids.runL, ids.runS].sort());
        // The run trace still resolves to a downloadable artifact.
        const agentRunRow = (await db.execute(sql`
          SELECT report_run_id FROM ai_agent_runs WHERE id = ${ids.agentRunL}::uuid`)) as unknown as Array<{
          report_run_id: string | null;
        }>;
        expect(agentRunRow[0]?.report_run_id).toBe(ids.runL);
        // Exactly one definition per (survivor org, schedule) — the whole point
        // of reports_source_ai_agent_schedule_uniq.
        const survivorDefs = (await db.execute(sql`
          SELECT id FROM reports
           WHERE org_id = ${S}::uuid AND source_ai_agent_schedule_id = ${ids.scheduleP}::uuid`)) as unknown as Array<{
          id: string;
        }>;
        expect(survivorDefs.map((r) => r.id)).toEqual([ids.reportS]);
        // Both ordinary reports survived and the loser's one moved across.
        const plainReports = (await db.execute(sql`
          SELECT id, org_id FROM reports
           WHERE id IN (${ids.reportPlainL}::uuid, ${ids.reportPlainS}::uuid) ORDER BY id`)) as unknown as Array<{
          id: string; org_id: string;
        }>;
        expect(plainReports).toHaveLength(2);
        expect(new Set(plainReports.map((r) => r.org_id))).toEqual(new Set([S]));
        asserted++;

        // Nothing left behind under the loser for the four whose move half ran
        // here. `discovered_assets` is excluded on purpose — see above: its
        // move half cannot run before `sites` does, so its one non-colliding
        // row is still under the loser at this point by design. The gauntlet
        // asserts the empty-under-loser property for it end to end.
        for (const table of ['plugin_installations', 'playbook_definitions', 'pam_signer_groups', 'incidents', 'reports']) {
          const left = (await db.execute(
            sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${L}::uuid`,
          )) as unknown as Array<{ n: number }>;
          expect(Number(left[0]?.n), table).toBe(0);
        }

        throw new Rollback('done');
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    expect(asserted).toBe(6);
  }, 120_000);

  it('moves automation binding ownership and its expected org atomically', async () => {
    const P = randomUUID();
    const L = randomUUID();
    const S = randomUUID();
    const A = randomUUID();
    const B = randomUUID();

    try {
      await withSystemDbAccessContext(async () => {
        await db.execute(sql`
          INSERT INTO partners (id, name, slug)
          VALUES (${P}::uuid, 'Automation binding merge', ${`automation-binding-${P.slice(0, 8)}`})`);
        await db.execute(sql`
          INSERT INTO organizations (id, partner_id, name, slug, status, currency_code)
          VALUES (${L}::uuid, ${P}::uuid, 'Loser', ${`loser-${L.slice(0, 8)}`}, 'active', 'USD'),
                 (${S}::uuid, ${P}::uuid, 'Survivor', ${`survivor-${S.slice(0, 8)}`}, 'active', 'USD')`);
        await db.execute(sql`
          INSERT INTO automations (id, org_id, name, trigger, actions)
          VALUES (${A}::uuid, ${L}::uuid, 'Bound automation', '{}'::jsonb, '[]'::jsonb)`);
        await db.execute(sql`
          INSERT INTO automation_resource_bindings (
            id, automation_id, org_id, resource_kind, resource_id,
            expected_resource_org_id, expected_resource_is_system, state
          ) VALUES (
            ${B}::uuid, ${A}::uuid, ${L}::uuid, 'script', ${randomUUID()},
            ${L}::uuid, false, 'active'
          )`);

        await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
        const out = await CUSTOM_EXECUTORS.automation_resource_bindings!(L, S);
        expect(out).toEqual({ moved: 1, dropped: 0, notes: [] });

        // The parent moves in its own registry step. Forcing the deferred
        // guards proves the custom child rewrite leaves a committable state.
        await db.execute(sql`UPDATE automations SET org_id = ${S}::uuid WHERE id = ${A}::uuid`);
        await db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);

        const rows = (await db.execute(sql`
          SELECT org_id, expected_resource_org_id
            FROM automation_resource_bindings
           WHERE id = ${B}::uuid`)) as unknown as Array<{
          org_id: string;
          expected_resource_org_id: string | null;
        }>;
        expect(rows).toEqual([{ org_id: S, expected_resource_org_id: S }]);

        throw new Rollback('done');
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });

  it('drops the merged-away org\'s QuickBooks mapping so its remote claim is released', async () => {
    // accounting_entity_mappings has no org_id column and its Breeze side is a
    // polymorphic (type, id) pair, so the registry walk never reaches it — the
    // post-pass fixup is the ONLY place an org merge can act on it. A surviving
    // loser row would keep `qbo-cust-loser` in claimedRemoteIds forever, hiding
    // that QuickBooks Customer from every proposal and 409ing any manual
    // confirm, with no UI able to show the row.
    const P = randomUUID();
    const L = randomUUID();
    const S = randomUUID();
    const conn = randomUUID();
    const item = randomUUID();
    // A SECOND, unrelated partner — proves the orphan sweep is scoped to the
    // merging partner and never touches (or miscounts) another partner's rows.
    const Q = randomUUID();
    const orgQ = randomUUID();
    const connQ = randomUUID();

    try {
      await withSystemDbAccessContext(async () => {
        // Both partners inserted together first: a partner-export lock
        // hierarchy guard (breeze_partner_export_lock_partners_exclusive)
        // rejects taking a new partner lock after an organization lock has
        // already been acquired in the same transaction, so every partner
        // row must exist before any organization insert touches either one.
        await db.execute(sql`
          INSERT INTO partners (id, name, slug)
          VALUES
            (${P}::uuid, 'QBO mapping merge', ${`qbo-mapping-${P.slice(0, 8)}`}),
            (${Q}::uuid, 'QBO mapping merge — foreign partner', ${`qbo-mapping-foreign-${Q.slice(0, 8)}`})`);
        await db.execute(sql`
          INSERT INTO organizations (id, partner_id, name, slug, status, currency_code)
          VALUES (${L}::uuid, ${P}::uuid, 'Loser', ${`loser-${L.slice(0, 8)}`}, 'active', 'USD'),
                 (${S}::uuid, ${P}::uuid, 'Survivor', ${`survivor-${S.slice(0, 8)}`}, 'active', 'USD'),
                 (${orgQ}::uuid, ${Q}::uuid, 'Foreign Org', ${`foreign-org-${orgQ.slice(0, 8)}`}, 'active', 'USD')`);
        await db.execute(sql`
          INSERT INTO accounting_connections (id, partner_id, provider, environment, status, home_currency)
          VALUES (${conn}::uuid, ${P}::uuid, 'quickbooks', 'sandbox', 'connected', 'USD'),
                 (${connQ}::uuid, ${Q}::uuid, 'quickbooks', 'sandbox', 'connected', 'USD')`);
        await db.execute(sql`
          INSERT INTO catalog_items (id, partner_id, item_type, name, unit_price, cost_currency)
          VALUES (${item}::uuid, ${P}::uuid, 'service', 'Managed Service', 100.00, 'USD')`);

        // A SECOND, unrelated partner (Q) with its own ALREADY-orphaned invoice
        // mapping (source invoice deleted up front, before the merge under
        // test even starts) — proves the orphan sweep is scoped to the
        // merging partner (P) and never touches (or miscounts) another
        // partner's rows.
        const foreignOrphanInvoiceSource = randomUUID();
        await db.execute(sql`
          INSERT INTO invoices (id, partner_id, org_id, currency_code, status)
          VALUES (${foreignOrphanInvoiceSource}::uuid, ${Q}::uuid, ${orgQ}::uuid, 'USD', 'sent')`);
        await db.execute(sql`
          INSERT INTO accounting_entity_mappings
            (integration_id, partner_id, breeze_entity_type, breeze_entity_id, remote_entity_type, remote_entity_id, link_status, sync_status)
          VALUES
            (${connQ}::uuid, ${Q}::uuid, 'invoice', ${foreignOrphanInvoiceSource}::uuid, 'Invoice', 'qbo-inv-foreign-orphan', 'confirmed', 'synced')`);
        await db.execute(sql`DELETE FROM invoices WHERE id = ${foreignOrphanInvoiceSource}::uuid`);

        // Phase C: a real invoice + payment under the LOSER org. During a real
        // merge these are REPOINTED (not deleted) by the plain-repoint walk
        // before runPostPassFixups ever runs (REPOINT_TABLES in
        // orgMergeRegistry.ts), so their id never changes and their mappings
        // stay valid. This test calls runPostPassFixups directly (no repoint
        // walk), so the invoice is still under L's org_id here — that's fine,
        // the fixup only cares whether the invoice/payment ROW exists, not
        // which org currently owns it.
        const invoiceLoser = randomUUID();
        await db.execute(sql`
          INSERT INTO invoices (id, partner_id, org_id, currency_code, status)
          VALUES (${invoiceLoser}::uuid, ${P}::uuid, ${L}::uuid, 'USD', 'sent')`);
        const paymentLoser = randomUUID();
        await db.execute(sql`
          INSERT INTO invoice_payments (id, invoice_id, org_id, amount, method, received_at)
          VALUES (${paymentLoser}::uuid, ${invoiceLoser}::uuid, ${L}::uuid, 50.00, 'card', now())`);

        // Two ORPHAN-TO-BE mapping rows. A trigger
        // (validate_accounting_mapping_entity_partner) rejects an INSERT
        // naming an invoice/payment id that doesn't exist yet, so a genuine
        // orphan can only arise the way it would in production: the mapping
        // is created against a REAL row, and that row is deleted afterward
        // through some other path (the trigger only fires on writes to
        // accounting_entity_mappings itself, never on invoices/invoice_payments
        // deletes). Simulate that here: create real rows, map them, then
        // delete the underlying rows out from under the mappings.
        const orphanInvoiceSource = randomUUID();
        await db.execute(sql`
          INSERT INTO invoices (id, partner_id, org_id, currency_code, status)
          VALUES (${orphanInvoiceSource}::uuid, ${P}::uuid, ${S}::uuid, 'USD', 'sent')`);
        const orphanPaymentInvoice = randomUUID();
        await db.execute(sql`
          INSERT INTO invoices (id, partner_id, org_id, currency_code, status)
          VALUES (${orphanPaymentInvoice}::uuid, ${P}::uuid, ${S}::uuid, 'USD', 'sent')`);
        const orphanPaymentSource = randomUUID();
        await db.execute(sql`
          INSERT INTO invoice_payments (id, invoice_id, org_id, amount, method, received_at)
          VALUES (${orphanPaymentSource}::uuid, ${orphanPaymentInvoice}::uuid, ${S}::uuid, 50.00, 'card', now())`);

        await db.execute(sql`
          INSERT INTO accounting_entity_mappings
            (integration_id, partner_id, breeze_entity_type, breeze_entity_id, remote_entity_type, remote_entity_id, link_status, sync_status)
          VALUES
            (${conn}::uuid, ${P}::uuid, 'org', ${L}::uuid, 'Customer', 'qbo-cust-loser', 'confirmed', 'synced'),
            (${conn}::uuid, ${P}::uuid, 'org', ${S}::uuid, 'Customer', 'qbo-cust-survivor', 'confirmed', 'synced'),
            (${conn}::uuid, ${P}::uuid, 'catalog_item', ${item}::uuid, 'Item', 'qbo-item-1', 'confirmed', 'synced'),
            (${conn}::uuid, ${P}::uuid, 'invoice', ${invoiceLoser}::uuid, 'Invoice', 'qbo-inv-loser', 'confirmed', 'synced'),
            (${conn}::uuid, ${P}::uuid, 'payment', ${paymentLoser}::uuid, 'Payment', 'qbo-pay-loser', 'confirmed', 'synced'),
            (${conn}::uuid, ${P}::uuid, 'invoice', ${orphanInvoiceSource}::uuid, 'Invoice', 'qbo-inv-orphan', 'confirmed', 'synced'),
            (${conn}::uuid, ${P}::uuid, 'payment', ${orphanPaymentSource}::uuid, 'Payment', 'qbo-pay-orphan', 'confirmed', 'synced')`);

        // Delete the source rows AFTER the mapping is created (past the
        // trigger's write-time check) to leave two genuine orphans. Deleting
        // orphanInvoiceSource has no payment child; deleting
        // orphanPaymentInvoice cascades and removes orphanPaymentSource too
        // (invoice_payments.invoice_id is ON DELETE CASCADE), which is exactly
        // how a real payment mapping would be orphaned — its invoice, not the
        // payment row directly, is what goes away.
        await db.execute(sql`DELETE FROM invoices WHERE id = ${orphanInvoiceSource}::uuid`);
        await db.execute(sql`DELETE FROM invoices WHERE id = ${orphanPaymentInvoice}::uuid`);

        const fixups = await runPostPassFixups(L, S, P);
        // org row (loser) + orphan invoice + orphan payment = 3. Must NOT
        // include the foreign partner's already-orphaned row — the sweep is
        // scoped to partner P only.
        expect(fixups.dropped).toBe(3);

        // Cross-tenant isolation: partner Q's orphaned mapping must survive
        // partner P's merge untouched. An unscoped sweep would delete this row
        // and silently fold a foreign partner's cleanup into P's merge summary
        // (misattributed counts, small cross-tenant signal in org_merge_events).
        const foreignRows = (await db.execute(sql`
          SELECT remote_entity_id FROM accounting_entity_mappings
           WHERE integration_id = ${connQ}::uuid`)) as unknown as Array<{ remote_entity_id: string }>;
        expect(foreignRows.map((r) => r.remote_entity_id)).toEqual(['qbo-inv-foreign-orphan']);

        const rows = (await db.execute(sql`
          SELECT breeze_entity_type, breeze_entity_id, remote_entity_id
            FROM accounting_entity_mappings
           WHERE integration_id = ${conn}::uuid
           ORDER BY remote_entity_id`)) as unknown as Array<{
          breeze_entity_type: string;
          breeze_entity_id: string;
          remote_entity_id: string;
        }>;

        // Loser org-row gone; the survivor's own mapping and the
        // partner-scoped catalog_item mapping untouched. Deleted rather than
        // repointed: the survivor already claims its own QuickBooks Customer,
        // so a repoint would collide on accounting_entity_mappings_breeze_uniq,
        // and the survivor must reconcile fresh rather than inherit a stale
        // claim.
        //
        // The invoice/payment mapping rows naming REAL rows (qbo-inv-loser,
        // qbo-pay-loser) survive — invoices move with the org, they are never
        // deleted by a merge, so their mapping stays valid regardless of which
        // org currently owns the row. Only the two ORPHAN rows (naming
        // nonexistent invoice/payment ids) are gone.
        expect(rows.map((r) => r.remote_entity_id)).toEqual([
          'qbo-cust-survivor',
          'qbo-inv-loser',
          'qbo-item-1',
          'qbo-pay-loser',
        ]);
        expect(rows.some((r) => r.breeze_entity_id === L)).toBe(false);
        expect(rows.some((r) => r.remote_entity_id === 'qbo-inv-orphan')).toBe(false);
        expect(rows.some((r) => r.remote_entity_id === 'qbo-pay-orphan')).toBe(false);

        throw new Rollback('done');
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
