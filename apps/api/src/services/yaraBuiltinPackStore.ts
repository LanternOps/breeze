/**
 * DB side of the built-in YARA pack boot upsert (#6263 W03b). See
 * yaraBuiltinPack.ts for the pipeline; this file only reads and writes.
 *
 * Every call opens its own short system-scope transaction OUTSIDE any ambient
 * request context (`runOutsideDbContext` → `withSystemDbAccessContext`). The
 * built-in row has both owners NULL, so the FOR ALL RLS policy admits writes
 * only under system scope — tenants get SELECT through the built-in branch.
 *
 * The write keeps Part A's published-snapshot invariants (migration
 * 2026-12-30-230000): published_version > 0 with a bundle and a lowercase
 * sha256 of exactly those bytes, published_version <= current_version, the
 * single-built-in unique index, and children whose owner columns the
 * `yara_rules_inherit_owner` trigger copies from the (built-in) parent.
 */
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { YARA_BUILTIN_RULE_SET_ID, type YaraBundleRuleInput } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { yaraRuleSets, yaraRules } from '../db/schema';
import type { BuiltinPackDecision } from './yaraBuiltinPack';

export interface BuiltinPackRow {
  isBuiltin: boolean;
  enabled: boolean;
  publishedVersion: number;
  publishedSha256: string | null;
  currentVersion: number;
}

export interface BuiltinPackWrite {
  /** The shipped bundle bytes, published byte for byte. */
  bytes: Buffer;
  sha256: string;
  version: number;
  rules: YaraBundleRuleInput[];
  /** `breeze-yarac version` engine, 'lint-only', or null when the probe failed. */
  engine: string | null;
  policy: number | null;
}

export type BuiltinPackApplyResult =
  | { applied: true; decision: 'apply' }
  | { applied: false; decision: Exclude<BuiltinPackDecision, 'apply'> };

const BUILTIN_NAME = 'Breeze built-in detection rules';
const BUILTIN_DESCRIPTION =
  'Read-only detection rules curated from permissively licensed YARA Forge sources and shipped with each Breeze release.';
const INSERT_CHUNK = 50;
// pg_advisory_xact_lock key: every replica boots this upsert.
const LOCK_KEY = 'yara-builtin-pack';

const rowColumns = {
  isBuiltin: yaraRuleSets.isBuiltin,
  enabled: yaraRuleSets.enabled,
  publishedVersion: yaraRuleSets.publishedVersion,
  publishedSha256: yaraRuleSets.publishedSha256,
  currentVersion: yaraRuleSets.currentVersion,
};

export async function readBuiltinPackRow(): Promise<BuiltinPackRow | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select(rowColumns)
        .from(yaraRuleSets)
        .where(eq(yaraRuleSets.id, YARA_BUILTIN_RULE_SET_ID))
        .limit(1);
      return row ?? null;
    }, 'yara-builtin-pack:read'),
  );
}

/**
 * The kill switch (BREEZE_YARA_BUILTIN_PACK_DISABLED). True when the row's
 * `enabled` actually changed; a missing row is a no-op.
 */
export async function setBuiltinPackEnabled(enabled: boolean): Promise<boolean> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const changed = await db
        .update(yaraRuleSets)
        .set({ enabled, updatedAt: new Date() })
        .where(and(
          eq(yaraRuleSets.id, YARA_BUILTIN_RULE_SET_ID),
          eq(yaraRuleSets.isBuiltin, true),
          eq(yaraRuleSets.enabled, !enabled),
        ))
        .returning({ id: yaraRuleSets.id });
      return changed.length > 0;
    }, 'yara-builtin-pack:enabled'),
  );
}

export async function applyBuiltinPack(
  w: BuiltinPackWrite,
  decide: (row: BuiltinPackRow | null) => BuiltinPackDecision,
): Promise<BuiltinPackApplyResult> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`);
      const [row] = await db
        .select(rowColumns)
        .from(yaraRuleSets)
        .where(eq(yaraRuleSets.id, YARA_BUILTIN_RULE_SET_ID))
        .for('update');
      const decision = decide(row ?? null);
      if (decision !== 'apply') return { applied: false, decision };

      const now = new Date();
      const snapshot = {
        name: BUILTIN_NAME,
        description: BUILTIN_DESCRIPTION,
        source: 'builtin',
        isBuiltin: true,
        orgId: null,
        partnerId: null,
        enabled: true,
        autoQuarantine: true, // spec D7: on only for the built-in pack
        currentVersion: Math.max(w.version, row?.currentVersion ?? 0),
        publishedVersion: w.version,
        publishedBundle: w.bytes,
        publishedSha256: w.sha256,
        publishedAt: now,
        publishedEngine: w.engine,
        publishedPolicy: w.policy,
        stale: false,
        ruleCount: w.rules.length,
        updatedAt: now,
      };
      if (row) {
        await db.update(yaraRuleSets).set(snapshot).where(eq(yaraRuleSets.id, YARA_BUILTIN_RULE_SET_ID));
      } else {
        await db.insert(yaraRuleSets).values({ id: YARA_BUILTIN_RULE_SET_ID, ...snapshot });
      }

      const ids = w.rules.map((r) => r.id);
      await db
        .delete(yaraRules)
        .where(and(eq(yaraRules.ruleSetId, YARA_BUILTIN_RULE_SET_ID), notInArray(yaraRules.id, ids)));
      for (let i = 0; i < w.rules.length; i += INSERT_CHUNK) {
        const chunk = w.rules.slice(i, i + INSERT_CHUNK).map((r) => ({
          id: r.id,
          ruleSetId: YARA_BUILTIN_RULE_SET_ID,
          name: r.name,
          source: r.source,
          severity: r.severity,
          enabled: true,
          compileError: null,
          updatedAt: now,
        }));
        await db
          .insert(yaraRules)
          .values(chunk)
          .onConflictDoUpdate({
            target: yaraRules.id,
            set: {
              name: sql`excluded.name`,
              source: sql`excluded.source`,
              severity: sql`excluded.severity`,
              enabled: sql`true`,
              compileError: sql`NULL`,
              updatedAt: sql`excluded.updated_at`,
            },
            // A colliding id under ANOTHER set is never taken over; the count
            // check below then fails the whole transaction.
            setWhere: sql`${yaraRules.ruleSetId} = excluded.rule_set_id`,
          });
      }
      const [counted] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(yaraRules)
        .where(eq(yaraRules.ruleSetId, YARA_BUILTIN_RULE_SET_ID));
      const n = counted?.n ?? -1;
      if (n !== w.rules.length) {
        throw new Error(`built-in rule count ${n} != pack rule count ${w.rules.length}; rolled back`);
      }
      return { applied: true, decision: 'apply' };
    }, 'yara-builtin-pack:apply'),
  );
}
