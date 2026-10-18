/**
 * Publishes a YARA rule set (#6263 W03a, DECISION W03-a, Open Decision 9).
 *
 * Every rule mutation, and every change to a set's `enabled`/`autoQuarantine`,
 * calls `publishRuleSet` in the same request transaction:
 *
 *  1. lock the set row (`FOR UPDATE` — also proves the caller may WRITE it;
 *     RLS hides read-only partner-wide/built-in rows from a locking read);
 *  2. build the canonical W02 §C2 bundle from its ENABLED rules at
 *     `current_version + 1`;
 *  3. pre-check it with `breeze-yarac validate`;
 *  4. write each rule's `compile_error`;
 *  5. only when the whole set passes, snapshot the bundle bytes + sha256 as
 *     the published version. Otherwise bump `current_version`, set `stale`,
 *     and leave the last good published snapshot in place — devices keep
 *     scanning with it and never see unpublished text.
 *
 * Two exceptions keep the fail-safe directions immediate:
 *  - a set with NO enabled rules is unpublished (published_version 0), so
 *    scans stop using it instead of running a zero-rule YARA scan;
 *  - turning auto-quarantine OFF while the set cannot be published republishes
 *    the last good rules with `autoQuarantine: false` (no recompile: the flag
 *    does not affect compilation). Otherwise devices would keep quarantining
 *    with the old bundle until someone fixed an unrelated broken rule.
 *
 * Pre-check unavailable (binary missing, timeout, engine failure) refuses to
 * publish in production. Lint-only publishing is a dev escape hatch behind
 * `BREEZE_YARA_LINT_ONLY=1` outside production; the set then records
 * `published_engine = 'lint-only'`.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { buildYaraBundleJson, type YaraBundleRuleInput, type YaraRuleSeverity } from '@breeze/shared';
import { db, assertInTransaction } from '../db';
import { yaraRuleSets, yaraRules } from '../db/schema';
import { precheckYaraBundle, yaracVersion, type YaraPrecheckError } from './yaraPrecheck';

export class YaraRuleSetNotFoundError extends Error {
  constructor(ruleSetId: string) {
    super(`YARA rule set ${ruleSetId} not found`);
    this.name = 'YaraRuleSetNotFoundError';
  }
}

export interface YaraPublishError {
  /** null for a bundle-level error no single rule owns (caps, decode). */
  ruleId: string | null;
  name: string;
  code: string;
  message: string;
  line?: number;
}

export interface PublishRuleSetResult {
  /** True when this call produced a new published version. */
  published: boolean;
  /**
   * The new version only flipped auto-quarantine off on the last good rules;
   * the edit that triggered the publish is NOT live (`stale` stays true).
   */
  autoQuarantineOnly?: boolean;
  /** The set's published version after this call (0 = never published). */
  version: number;
  /** The set's edit counter after this call. */
  currentVersion: number;
  stale: boolean;
  errors: YaraPublishError[];
  /** Set when the pre-check could not run; never published in production. */
  unavailable?: string;
}

const COMPILE_ERROR_MAX = 2000;

/** Dev escape hatch only; an unset NODE_ENV is NOT a dev environment. */
function lintOnlyAllowed(): boolean {
  const env = process.env.NODE_ENV;
  return (env === 'development' || env === 'test') && process.env.BREEZE_YARA_LINT_ONLY === '1';
}

/** The `autoQuarantine` and rules of a stored (already validated) bundle, or null. */
function parsePublishedBundle(bytes: Buffer | null): { autoQuarantine: boolean; rules: YaraBundleRuleInput[] } | null {
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as { autoQuarantine?: unknown; rules?: unknown };
    if (typeof parsed.autoQuarantine !== 'boolean' || !Array.isArray(parsed.rules)) return null;
    return { autoQuarantine: parsed.autoQuarantine, rules: parsed.rules as YaraBundleRuleInput[] };
  } catch {
    return null;
  }
}

export async function publishRuleSet(ruleSetId: string): Promise<PublishRuleSetResult> {
  assertInTransaction('publishRuleSet');

  const [set] = await db
    .select({
      id: yaraRuleSets.id,
      currentVersion: yaraRuleSets.currentVersion,
      publishedVersion: yaraRuleSets.publishedVersion,
      autoQuarantine: yaraRuleSets.autoQuarantine,
      isBuiltin: yaraRuleSets.isBuiltin,
      publishedBundle: yaraRuleSets.publishedBundle,
    })
    .from(yaraRuleSets)
    .where(eq(yaraRuleSets.id, ruleSetId))
    .for('update');
  if (!set) throw new YaraRuleSetNotFoundError(ruleSetId);
  if (set.isBuiltin) {
    throw new Error('The built-in YARA rule set is published only by the release boot upsert');
  }

  const rules = await db
    .select({
      id: yaraRules.id,
      name: yaraRules.name,
      severity: yaraRules.severity,
      source: yaraRules.source,
      compileError: yaraRules.compileError,
    })
    .from(yaraRules)
    .where(and(eq(yaraRules.ruleSetId, ruleSetId), eq(yaraRules.enabled, true)))
    .orderBy(asc(yaraRules.id));

  const version = set.currentVersion + 1;
  const now = new Date();

  if (rules.length === 0) {
    await db
      .update(yaraRuleSets)
      .set({
        currentVersion: version,
        publishedVersion: 0,
        publishedBundle: null,
        publishedSha256: null,
        publishedAt: null,
        publishedEngine: null,
        publishedPolicy: null,
        stale: false,
        ruleCount: 0,
        updatedAt: now,
      })
      .where(eq(yaraRuleSets.id, ruleSetId));
    return { published: false, version: 0, currentVersion: version, stale: false, errors: [] };
  }

  const json = buildYaraBundleJson({
    ruleSetId,
    version,
    autoQuarantine: set.autoQuarantine,
    rules: rules.map((r) => ({ id: r.id, name: r.name, severity: r.severity as YaraRuleSeverity, source: r.source })),
  });

  const check = await precheckYaraBundle(json);
  const precheckErrors: YaraPrecheckError[] = !check.ok && 'errors' in check ? check.errors : [];
  const ruleIds = new Set(rules.map((r) => r.id));

  const errorByRule = new Map<string, string>();
  for (const e of precheckErrors) {
    if (!e.ruleId || !ruleIds.has(e.ruleId)) continue;
    const msg = `${e.code}: ${e.message}`;
    const prev = errorByRule.get(e.ruleId);
    errorByRule.set(e.ruleId, (prev ? `${prev}\n${msg}` : msg).slice(0, COMPILE_ERROR_MAX));
  }

  // Per-rule state is only known after a real compile: a clean pass, or a
  // result that attributes errors to rules. An unavailable pre-check or a
  // bundle-level-only failure (caps, decode) says nothing about individual
  // rules, so stored errors are left as they are. Only changed rows are written.
  const ruleStateKnown = check.ok || precheckErrors.some((e) => e.ruleId && ruleIds.has(e.ruleId));
  for (const r of ruleStateKnown ? rules : []) {
    const next = errorByRule.get(r.id) ?? null;
    if (next === r.compileError) continue;
    await db.update(yaraRules).set({ compileError: next, updatedAt: now }).where(eq(yaraRules.id, r.id));
  }

  const errors: YaraPublishError[] = precheckErrors.map((e) => ({
    ruleId: e.ruleId && ruleIds.has(e.ruleId) ? e.ruleId : null,
    name: e.name,
    code: e.code,
    message: e.message,
    ...(e.line !== undefined ? { line: e.line } : {}),
  }));

  const unavailable = !check.ok && 'unavailable' in check ? check.unavailable : undefined;
  const lintOnly = unavailable !== undefined && lintOnlyAllowed();

  if (!check.ok && !lintOnly) {
    if (unavailable !== undefined) {
      console.error('[yara] pre-check unavailable; rule set left on its last published version', {
        ruleSetId,
        reason: unavailable,
        lastPublishedVersion: set.publishedVersion,
      });
    }

    const lastGood = parsePublishedBundle(set.publishedBundle);
    if (set.publishedVersion > 0 && set.publishedBundle && !lastGood) {
      console.error('[yara] stored published bundle is unreadable; auto-quarantine fail-safe skipped', { ruleSetId });
    }
    if (lastGood && lastGood.autoQuarantine && !set.autoQuarantine) {
      const flagOnly = Buffer.from(
        buildYaraBundleJson({ ruleSetId, version, autoQuarantine: false, rules: lastGood.rules }),
        'utf8',
      );
      await db
        .update(yaraRuleSets)
        .set({
          currentVersion: version,
          publishedVersion: version,
          publishedBundle: flagOnly,
          publishedSha256: createHash('sha256').update(flagOnly).digest('hex'),
          publishedAt: now,
          stale: true,
          ruleCount: rules.length,
          updatedAt: now,
        })
        .where(eq(yaraRuleSets.id, ruleSetId));
      return {
        published: true,
        autoQuarantineOnly: true,
        version,
        currentVersion: version,
        stale: true,
        errors,
        ...(unavailable !== undefined ? { unavailable } : {}),
      };
    }

    await db
      .update(yaraRuleSets)
      .set({ currentVersion: version, stale: true, ruleCount: rules.length, updatedAt: now })
      .where(eq(yaraRuleSets.id, ruleSetId));
    return {
      published: false,
      version: set.publishedVersion,
      currentVersion: version,
      stale: true,
      errors,
      ...(unavailable !== undefined ? { unavailable } : {}),
    };
  }

  const engine = check.ok ? await yaracVersion() : null;
  if (check.ok && !engine) {
    console.warn('[yara] breeze-yarac version probe failed after a clean pre-check; publishing without an engine stamp', { ruleSetId });
  }
  const bytes = Buffer.from(json, 'utf8');
  await db
    .update(yaraRuleSets)
    .set({
      currentVersion: version,
      publishedVersion: version,
      publishedBundle: bytes,
      publishedSha256: createHash('sha256').update(bytes).digest('hex'),
      publishedAt: now,
      publishedEngine: check.ok ? (engine?.engine ?? null) : 'lint-only',
      publishedPolicy: check.ok ? (engine?.policy ?? null) : null,
      stale: false,
      ruleCount: rules.length,
      updatedAt: now,
    })
    .where(eq(yaraRuleSets.id, ruleSetId));

  return { published: true, version, currentVersion: version, stale: false, errors: [] };
}
